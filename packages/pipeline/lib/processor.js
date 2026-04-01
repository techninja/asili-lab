import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pgsApiClient from '../pgs-api-client.js';
import {
  needsUpdate,
  createStandardizedExportQuery,
  validateParquetFile,
  prepareFileForProcessing,
  openDuckDB,
  closeDuckDB,
  exec,
  query,
  OUTPUT_DIR,
  PACKS_DIR
} from './processor-core.js';
import { detectFormat, generateInsertSQL } from './harmonization.js';
import { getPGS } from './pgs-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_SQL_DIR = path.join(OUTPUT_DIR, 'temp_sql');

export { shouldExcludePGS } from './pgs-filter.js';

import { generateTraitPackBatched } from './batched-processor.js';

export async function generateTraitPack(traitName, config, allMetadataCache = null) {
  if (
    config.pgs_ids.length > 10 ||
    (config.expected_variants && config.expected_variants > 1000000)
  ) {
    console.log(
      `  - Using batched processing for ${traitName} (${config.pgs_ids.length} PGS files)`
    );
    return generateTraitPackBatched(traitName, config, allMetadataCache);
  }

  return generateTraitPackDirect(traitName, config);
}

async function generateTraitPackDirect(traitName, config) {
  if (!process.env.SINGLE_TRAIT) {
    const needsFileUpdate = await needsUpdate(traitName, config);
    if (!needsFileUpdate) {
      console.log('  - Files up to date, skipping...');
      const safeFileName = traitName.replace(':', '_');
      return {
        timestamp: new Date().toISOString(),
        variant_count: config.expected_variants || 0,
        fileName: `${safeFileName}_hg38.parquet`,
        metadata_only: true
      };
    }
  }

  console.log(`  - Generating ${traitName}...`);
  const result = await streamProcessWithDuckDB(traitName, config);
  return {
    timestamp: new Date().toISOString(),
    variant_count: result?.totalVariants || 0,
    fileName: result?.fileName || null
  };
}

async function streamProcessWithDuckDB(traitName, config) {
  console.log(`  - ${traitName}: Streaming process with DuckDB...`);

  const safeFileName = traitName.replace(':', '_');
  const outputPath = path.join(PACKS_DIR, `${safeFileName}_hg38.parquet`);
  const dbDir = process.env.LARGE_TMP || OUTPUT_DIR;
  const dbPath = path.join(dbDir, `${safeFileName}.duckdb`);

  await fs.mkdir(PACKS_DIR, { recursive: true });
  await fs.mkdir(TEMP_SQL_DIR, { recursive: true });

  // Open persistent connection
  let duckHandle;
  let resuming = false;

  try {
    // Check for resumable database
    try {
      await fs.access(dbPath);
      duckHandle = openDuckDB(dbPath);
      const rows = await query(
        duckHandle.conn,
        'SELECT COUNT(*) as count, COUNT(DISTINCT pgs_id) as pgs_count FROM pgs_staging'
      );
      const existing = Number(rows[0]?.count ?? 0);
      if (existing > 0) {
        console.log(`    ✓ Resuming: ${existing} variants from ${rows[0].pgs_count} PGS`);
        resuming = true;
      }
    } catch {
      // No existing DB or table — start fresh
      if (duckHandle) closeDuckDB(duckHandle);
      duckHandle = openDuckDB(dbPath);
    }

    if (!resuming) {
      await exec(duckHandle.conn, `
        DROP TABLE IF EXISTS pgs_staging;
        CREATE TABLE pgs_staging (
          variant_id VARCHAR,
          chr_name VARCHAR,
          chr_position BIGINT,
          effect_allele VARCHAR,
          other_allele VARCHAR,
          effect_weight DOUBLE,
          pgs_id VARCHAR,
          source_family VARCHAR,
          source_type VARCHAR,
          source_subtype VARCHAR,
          source_weight DOUBLE,
          weight_type VARCHAR,
          format_type VARCHAR
        );
      `);
      console.log('    ✓ Database initialized');
    }

    let totalVariants = 0;
    const pgsIds = [];

    // Pipeline: download+prepare next PGS while importing current one
    // Pre-fetch up to PREFETCH_AHEAD files ahead of the import cursor
    const PREFETCH_AHEAD = 3;
    const prepared = new Map(); // pgsId -> { columns, dataOnlyPath, dataLineCount, formatType, importSQL } | null
    const preparing = new Map(); // pgsId -> Promise

    async function preparePGS(pgsId) {
      try {
        const t0 = Date.now();
        const scoreData = await pgsApiClient.getScore(pgsId);
        if (!scoreData.ftp_scoring_file) return null;
        const filePath = await pgsApiClient.downloadPGSFile(pgsId, scoreData.ftp_scoring_file);
        const dlTime = Date.now() - t0;
        const t1 = Date.now();
        const { columns, dataOnlyPath } = await prepareFileForProcessing(filePath);
        const prepTime = Date.now() - t1;
        const formatType = detectFormat(columns);
        if (!formatType) {
          console.log(`        ⚠ ${pgsId}: unsupported format (${columns.join(',')})`);
          return null;
        }
        const importSQL = generateInsertSQL(formatType, columns, dataOnlyPath, pgsId, config, traitName);
        console.log(`        📦 ${pgsId}: ${formatType} (dl:${dlTime}ms prep:${prepTime}ms)`);
        return { dataOnlyPath, formatType, importSQL };
      } catch (error) {
        console.log(`        ✗ ${pgsId} prepare failed: ${error.message}`);
        return null;
      }
    }

    // Kick off prefetch for first batch
    for (let i = 0; i < Math.min(PREFETCH_AHEAD, config.pgs_ids.length); i++) {
      const id = config.pgs_ids[i];
      preparing.set(id, preparePGS(id));
    }

    for (let idx = 0; idx < config.pgs_ids.length; idx++) {
      const pgsId = config.pgs_ids[idx];

      // Kick off next prefetch
      const nextIdx = idx + PREFETCH_AHEAD;
      if (nextIdx < config.pgs_ids.length) {
        const nextId = config.pgs_ids[nextIdx];
        if (!preparing.has(nextId)) {
          preparing.set(nextId, preparePGS(nextId));
        }
      }

      // Check if already in DB (resume support)
      if (resuming) {
        const rows = await query(
          duckHandle.conn,
          `SELECT COUNT(*) as count FROM pgs_staging WHERE pgs_id = '${pgsId}'`
        );
        const existing = Number(rows[0]?.count ?? 0);
        if (existing > 0) {
          console.log(`        ✓ Skipping ${pgsId} (${existing} variants already in DB)`);
          totalVariants += existing;
          pgsIds.push(pgsId);
          continue;
        }
      }

      // Await the prepared data (download+decompress already overlapped with previous import)
      const prep = await (preparing.get(pgsId) || preparePGS(pgsId));
      preparing.delete(pgsId);

      if (!prep) {
        console.log(`        Skipping ${pgsId} (no data or unsupported format)`);
        continue;
      }

      console.log(`        Importing ${pgsId} (${prep.formatType})...`);

      try {
        const t2 = Date.now();
        await exec(duckHandle.conn, prep.importSQL);

        const rows = await query(
          duckHandle.conn,
          `SELECT COUNT(*) as count FROM pgs_staging WHERE pgs_id = '${pgsId}'`
        );
        const variantCount = Number(rows[0]?.count ?? 0);
        console.log(`        ✓ ${pgsId}: ${variantCount.toLocaleString()} variants (${Date.now() - t2}ms)`);

        totalVariants += variantCount;
        pgsIds.push(pgsId);
      } catch (error) {
        console.log(`        Error importing ${pgsId}: ${error.message}`);
      }

      await fs.unlink(prep.dataOnlyPath).catch(() => {});
    }

    if (totalVariants === 0) {
      console.log('  - Skipped (no variants found)');
      closeDuckDB(duckHandle);
      await fs.unlink(dbPath).catch(() => {});
      return { totalVariants: 0, fileName: null, pgsIds: [] };
    }

    // Export to parquet
    console.log(`    Exporting to Parquet (${totalVariants} variants)...`);
    const exportSQL = createStandardizedExportQuery('pgs_staging', outputPath);
    await exec(duckHandle.conn, exportSQL);
    console.log('    ✓ Export complete');

    const validation = await validateParquetFile(outputPath);
    console.log(
      `    ✓ Parquet: ${validation.size} bytes, ${validation.variantCount} variants`
    );

    // Cleanup
    closeDuckDB(duckHandle);
    duckHandle = null;
    await fs.unlink(dbPath).catch(() => {});

    // Clean leftover temp files
    try {
      const files = await fs.readdir(OUTPUT_DIR);
      for (const file of files) {
        if (
          file.includes(safeFileName) &&
          (file.endsWith('.sql') || file.endsWith('.tsv') || file.endsWith('_data.tsv'))
        ) {
          await fs.unlink(path.join(OUTPUT_DIR, file)).catch(() => {});
        }
      }
    } catch { /* ignore */ }

    console.log(`  - Created unified file (${totalVariants} variants)`);
    return { totalVariants, fileName: `${safeFileName}_hg38.parquet`, pgsIds };
  } catch (error) {
    console.log(`  - DuckDB streaming failed: ${error.message}`);
    if (duckHandle) closeDuckDB(duckHandle);
    throw error;
  }
}
