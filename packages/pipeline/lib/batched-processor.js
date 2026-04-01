import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import pgsApiClient from '../pgs-api-client.js';
import {
  needsUpdate,
  countVariantsInFile,
  validateParquetFile,
  prepareFileForProcessing,
  query as duckQuery
} from './processor-core.js';
import {
  detectFormat,
  generateColumnExpressions,
  getColumnRef,
  FORMAT_TYPES
} from './harmonization.js';
import { createLogger } from '../../core/src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR =
  process.env.OUTPUT_DIR || path.join(__dirname, '..', '..', '..', 'data_out');
const BATCH_DIR = path.join(OUTPUT_DIR, 'batches');
const PACKS_DIR = path.join(OUTPUT_DIR, 'packs');

import os from 'os';

// Ensure batch directory exists
await fs.mkdir(BATCH_DIR, { recursive: true });
await fs.mkdir(PACKS_DIR, { recursive: true });

async function createBatches(pgsIds, maxVariantsPerBatch = null) {
  console.log(`📦 Analyzing ${pgsIds.length} PGS files for batching...`);

  if (!maxVariantsPerBatch) {
    if (pgsIds.length > 80) maxVariantsPerBatch = 500000;
    else if (pgsIds.length > 60) maxVariantsPerBatch = 750000;
    else if (pgsIds.length > 40) maxVariantsPerBatch = 1000000;
    else maxVariantsPerBatch = 2000000;
  }

  console.log(
    `    Using batch size: ${maxVariantsPerBatch.toLocaleString()} variants per batch`
  );

  // Try to get variant counts from manifest DB (fast) before falling back to streaming
  const { getPGS } = await import('./pgs-db.js');
  const dbCounts = new Map();
  for (const pgsId of pgsIds) {
    try {
      const row = await getPGS(pgsId);
      if (row?.variants_number) dbCounts.set(pgsId, Number(row.variants_number));
    } catch { /* ignore */ }
  }

  // Resolve file paths + variant counts
  const fileInfo = [];
  const toStream = []; // PGS IDs that need streaming count

  // Resolve all file paths in parallel
  const pathResults = await Promise.all(pgsIds.map(async pgsId => {
    try {
      const scoreData = await pgsApiClient.getScore(pgsId);
      if (!scoreData.ftp_scoring_file) return null;
      const filePath = await pgsApiClient.downloadPGSFile(pgsId, scoreData.ftp_scoring_file);
      if (!filePath) return null;
      return { pgs_id: pgsId, file_path: filePath, url: scoreData.ftp_scoring_file };
    } catch (error) {
      console.log(`    ${pgsId}: Error - ${error.message}`);
      return null;
    }
  }));

  for (const result of pathResults) {
    if (!result) continue;
    const dbCount = dbCounts.get(result.pgs_id);
    if (dbCount) {
      fileInfo.push({ ...result, variants: dbCount });
    } else {
      toStream.push(result);
    }
  }

  // Stream-count only the ones missing from DB
  if (toStream.length > 0) {
    console.log(`    Streaming variant count for ${toStream.length} files not in DB...`);
    for (const file of toStream) {
      try {
        const variantCount = await countVariantsInFile(file.file_path);
        fileInfo.push({ ...file, variants: variantCount });
      } catch (error) {
        console.log(`    ${file.pgs_id}: Count failed - ${error.message}`);
      }
    }
  }

  console.log(
    `    ✓ Total: ${fileInfo.length}/${pgsIds.length} files ready (${dbCounts.size} from DB)`
  );
  console.log(
    `    Total variants: ${fileInfo.reduce((sum, f) => sum + f.variants, 0).toLocaleString()}`
  );

  // Create batches based on variant counts
  const batches = [];
  let currentBatch = [];
  let currentCount = 0;

  for (const file of fileInfo) {
    if (currentCount + file.variants > maxVariantsPerBatch && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentCount = 0;
    }
    currentBatch.push(file);
    currentCount += file.variants;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  console.log(`📦 Created ${batches.length} batches`);
  return batches;
}

async function processBatchWithDuckDB(
  batch,
  batchNum,
  traitName,
  totalBatches,
  pgsMetadata = new Map(),
  logger = console
) {
  logger.log(
    `🦆 Processing batch ${batchNum}/${totalBatches}: ${batch.length} files, ${batch.reduce((sum, f) => sum + f.variants, 0).toLocaleString()} variants`
  );

  const safeFileName = traitName.replace(':', '_');
  const batchDbPath = path.join(
    BATCH_DIR,
    `${safeFileName}_batch_${batchNum}.duckdb`
  );
  const batchOutputPath = path.join(
    BATCH_DIR,
    `${safeFileName}_batch_${batchNum}.parquet`
  );

  // Prepare data files and detect column counts
  const fileQueries = [];
  for (const file of batch) {
    if (!file.file_path || typeof file.file_path !== 'string') {
      logger.log(
        `    Warning: Invalid file path for ${file.pgs_id}: ${file.file_path}`
      );
      continue;
    }

    try {
      const { columns, dataOnlyPath } =
        await prepareFileForProcessing(file.file_path);

      // Use harmonization logic to detect format and get proper column expressions
      const formatType = detectFormat(columns);
      if (!formatType) {
        logger.log(
          `    Warning: Unsupported format for ${file.pgs_id} - columns: ${columns.join(', ')}`
        );
        continue;
      }

      logger.log(
        `    ${file.pgs_id}: ${formatType} format (${columns.length} columns)`
      );

      const expressions = generateColumnExpressions(formatType, columns);
      const weightCol =
        formatType === FORMAT_TYPES.DOSAGE_WEIGHTS
          ? getColumnRef(columns, 'dosage_1_weight')
          : getColumnRef(columns, 'effect_weight');

      const hasOtherAllele = columns.includes('other_allele');
      const gnomadPath = process.env.GNOMAD_PARQUET_PATH;

      // If other_allele is missing and gnomAD is available, look it up
      if (
        !hasOtherAllele &&
        gnomadPath &&
        (formatType === FORMAT_TYPES.STANDARD_SNP ||
          formatType === FORMAT_TYPES.STANDARD_SNP_NO_RSID)
      ) {
        const chrNameCol = getColumnRef(columns, 'chr_name');
        const chrPosCol = getColumnRef(columns, 'chr_position');
        const effectAlleleCol = getColumnRef(columns, 'effect_allele');
        const effectWeightCol = getColumnRef(columns, 'effect_weight');

        fileQueries.push(`
            -- Process ${file.pgs_id} (${formatType} format with gnomAD lookup)
            INSERT INTO batch_variants
            SELECT 
                CASE 
                    WHEN g.ref IS NOT NULL AND g.alt IS NOT NULL THEN
                        CONCAT(REPLACE(csv.${chrNameCol}, 'chr', ''), ':', COALESCE(csv.${chrPosCol}::TEXT, ''), ':', g.ref, ':', g.alt)
                    ELSE
                        CONCAT(REPLACE(csv.${chrNameCol}, 'chr', ''), ':', COALESCE(csv.${chrPosCol}::TEXT, ''), ':', csv.${effectAlleleCol})
                END as variant_id,
                csv.${effectAlleleCol} as effect_allele,
                TRY_CAST(csv.${effectWeightCol} AS DOUBLE) as effect_weight,
                '${file.pgs_id}' as pgs_id
            FROM read_csv('${dataOnlyPath}', delim='\t', header=true, comment='#', all_varchar=true) csv
            LEFT JOIN read_parquet('${gnomadPath}') g 
                ON 'chr' || REPLACE(csv.${chrNameCol}, 'chr', '') = g.chr 
                AND TRY_CAST(csv.${chrPosCol} AS BIGINT) = g.pos
                AND csv.${effectAlleleCol} = g.alt
            WHERE csv.${effectAlleleCol} IS NOT NULL 
              AND csv.${effectAlleleCol} != ''
              AND csv.${weightCol} IS NOT NULL
              AND csv.${weightCol} != '';
            `);
      } else {
        const extraFilter = expressions._filter ? `AND ${expressions._filter}` : '';
        fileQueries.push(`
            -- Process ${file.pgs_id} (${formatType} format, ${columns.length} columns)
            INSERT INTO batch_variants
            SELECT 
                ${expressions.variant_id} as variant_id,
                ${expressions.effect_allele} as effect_allele,
                ${expressions.effect_weight} as effect_weight,
                '${file.pgs_id}' as pgs_id
            FROM read_csv('${dataOnlyPath}', delim='\t', header=true, comment='#', all_varchar=true)
            WHERE ${expressions.effect_allele} IS NOT NULL 
              AND ${expressions.effect_allele} != ''
              AND ${weightCol} IS NOT NULL
              AND ${weightCol} != ''
              ${extraFilter};
            `);
      }
    } catch (error) {
      logger.log(
        `    Warning: Could not prepare ${file.pgs_id}: ${error.message}`
      );
    }
  }

  // Create DuckDB subprocess to avoid memory issues
  const duckdbScript = `
        DROP TABLE IF EXISTS batch_variants;
        
        CREATE TABLE batch_variants (
            variant_id VARCHAR,
            effect_allele VARCHAR,
            effect_weight DOUBLE,
            pgs_id VARCHAR
        );
        
        ${fileQueries.join('\n')}
        
        -- Enforce standard schema with chr/pos/allele_key integer columns
        CREATE OR REPLACE TABLE batch_variants_standardized AS
        SELECT 
            COALESCE(variant_id, '') as variant_id,
            COALESCE(effect_allele, '') as effect_allele,
            COALESCE(effect_weight, 0.0) as effect_weight,
            COALESCE(pgs_id, '') as pgs_id,
            CASE SPLIT_PART(COALESCE(variant_id, ''), ':', 1)
              WHEN 'X' THEN 23::TINYINT WHEN 'Y' THEN 24::TINYINT WHEN 'MT' THEN 25::TINYINT
              ELSE TRY_CAST(SPLIT_PART(COALESCE(variant_id, ''), ':', 1) AS TINYINT)
            END AS chr,
            TRY_CAST(SPLIT_PART(COALESCE(variant_id, ''), ':', 2) AS INTEGER) AS pos,
            ('0x' || md5(LEAST(SPLIT_PART(COALESCE(variant_id,''),':',3), SPLIT_PART(COALESCE(variant_id,''),':',4))
              || ':' ||
              GREATEST(SPLIT_PART(COALESCE(variant_id,''),':',3), SPLIT_PART(COALESCE(variant_id,''),':',4))
            )[:15])::BIGINT AS allele_key
        FROM batch_variants
        WHERE variant_id IS NOT NULL AND variant_id != ''
          AND effect_allele IS NOT NULL AND effect_allele != ''
          AND effect_weight IS NOT NULL
          AND NOT contains(SPLIT_PART(variant_id, ':', 1), '_');
        
        -- Export batch results
        COPY (
            SELECT DISTINCT 
                variant_id,
                effect_allele,
                effect_weight,
                pgs_id,
                chr,
                pos,
                allele_key
            FROM batch_variants_standardized 
            ORDER BY chr, pos, allele_key
        ) TO '${batchOutputPath}' (FORMAT PARQUET, COMPRESSION SNAPPY);
    `;

  // Write SQL script
  const scriptPath = path.join(BATCH_DIR, `batch_${batchNum}.sql`);
  await fs.writeFile(scriptPath, duckdbScript);

  // Run DuckDB with higher memory limits
  return new Promise((resolve, reject) => {
    const memoryLimit = process.env.DUCKDB_MEMORY_LIMIT || '16GB';
    const threads =
      process.env.DUCKDB_THREADS ||
      Math.max(4, Math.floor(os.cpus().length / 2));

    const duckdb = spawn('duckdb', [batchDbPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: OUTPUT_DIR,
      env: {
        ...process.env,
        DUCKDB_MEMORY_LIMIT: memoryLimit
      }
    });

    const pragmas = `
      PRAGMA memory_limit='${memoryLimit}';
      PRAGMA threads=${threads};
      PRAGMA temp_directory='/tmp';
    `;

    duckdb.stdin.write(pragmas + duckdbScript);
    duckdb.stdin.end();

    let _stdout = '';
    let stderr = '';

    duckdb.stdout.on('data', _data => {
      // Silent - no debug output
    });

    duckdb.stderr.on('data', data => {
      stderr += data.toString();
    });

    duckdb.on('close', async code => {
      // Cleanup temp files
      try {
        await fs.unlink(scriptPath);
        await fs.unlink(batchDbPath);

        // Cleanup data files
        for (const file of batch) {
          const dataPath = file.file_path.replace('.gz', '_data.tsv');
          try {
            await fs.unlink(dataPath);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }

      if (
        code === 0 &&
        (await fs
          .access(batchOutputPath)
          .then(() => true)
          .catch(() => false))
      ) {
        logger.log(`    ✅ Batch ${batchNum}/${totalBatches} complete`);
        resolve(batchOutputPath);
      } else {
        logger.log(
          `    ❌ Batch ${batchNum}/${totalBatches} failed (code ${code})`
        );
        if (stderr) logger.log(`    Error: ${stderr}`);
        reject(new Error(`Batch ${batchNum}/${totalBatches} failed`));
      }
    });
  });
}

async function mergeBatchResults(batchFiles, traitName) {
  console.log(`🔄 Merging ${batchFiles.length} batch results...`);

  const validBatchFiles = batchFiles.filter(filePath => {
    if (!filePath || typeof filePath !== 'string') {
      console.log(`    Warning: Skipping invalid batch file path: ${filePath}`);
      return false;
    }
    return true;
  });

  if (validBatchFiles.length === 0) throw new Error('No valid batch files to merge');

  const safeFileName = traitName.replace(':', '_');
  const finalOutputPath = path.join(PACKS_DIR, `${safeFileName}_hg38.parquet`);

  // Single DuckDB query: read all batch parquets and write merged output
  const fileList = validBatchFiles.map(f => `'${f}'`).join(', ');
  const { execSync } = await import('child_process');
  const memoryLimit = process.env.DUCKDB_MEMORY_LIMIT || '16GB';
  const threads = process.env.DUCKDB_THREADS || Math.max(4, Math.floor(os.cpus().length / 2));

  const sql = `
    PRAGMA memory_limit='${memoryLimit}';
    PRAGMA threads=${threads};
    COPY (
      SELECT variant_id, effect_allele, effect_weight, pgs_id, chr, pos, allele_key
      FROM read_parquet([${fileList}])
    ) TO '${finalOutputPath}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `;

  try {
    execSync(`duckdb :memory: "${sql.replace(/"/g, '\"')}"`, {
      cwd: OUTPUT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024
    });
    console.log(`    ✓ DuckDB merge complete`);
  } catch (error) {
    // If inline SQL fails (too long), write to temp file
    console.log(`    Inline merge failed, using SQL file...`);
    const sqlPath = path.join(BATCH_DIR, `${safeFileName}_merge.sql`);
    const { writeFile, unlink } = await import('fs/promises');
    await writeFile(sqlPath, sql);
    try {
      execSync(`duckdb :memory: < '${sqlPath}'`, {
        cwd: OUTPUT_DIR,
        stdio: 'inherit',
        shell: true
      });
    } finally {
      await unlink(sqlPath).catch(() => {});
    }
  }

  return finalOutputPath;
}

export async function generateTraitPackBatched(
  traitName,
  config,
  _allMetadataCache = null
) {
  const logger = createLogger('batched-processor');
  const traitTitle = config.title || traitName;
  logger.log(`🧬 Starting batched processing for ${traitTitle} (${traitName})`);
  logger.log(`   Target: ${config.pgs_ids.length} PGS files`);

  const safeFileName = traitName.replace(':', '_');
  const _finalOutputPath = path.join(PACKS_DIR, `${safeFileName}_hg38.parquet`);

  if (!process.env.SINGLE_TRAIT) {
    const needsFileUpdate = await needsUpdate(traitName, config);

    if (!needsFileUpdate) {
      logger.log('  - Files up to date, skipping...');
      logger.close();
      return {
        timestamp: new Date().toISOString(),
        variant_count: config.expected_variants || 0,
        fileName: `${safeFileName}_hg38.parquet`,
        metadata_only: true
      };
    }
  }

  logger.log(
    `  - Generating ${traitTitle} (${traitName}) using batched processing...`
  );

  const progressFile = path.join(OUTPUT_DIR, `${safeFileName}_progress.json`);

  let progress = { completed_batches: [] };
  try {
    const progressData = await fs.readFile(progressFile, 'utf8');
    progress = JSON.parse(progressData);
    if (progress.completed_batches.length > 0) {
      logger.log(
        `📂 Resuming: ${progress.completed_batches.length} batches already completed`
      );
    }
  } catch {
    /* ignore */
  }

  const batches = await createBatches(config.pgs_ids);

  // Collect LD metadata from database (already calculated during trait refresh)
  logger.log('   Collecting LD metadata...');
  const pgsMetadata = new Map();

  // Import database access
  const { getPGS } = await import('./pgs-db.js');

  for (const pgsId of config.pgs_ids) {
    try {
      const dbData = await getPGS(pgsId);
      if (dbData) {
        pgsMetadata.set(pgsId, {});
      }
    } catch (_error) { /* ignore */ }
  }

  // Process batches in parallel with proper Promise handling
  const maxParallel =
    parseInt(process.env.MAX_PARALLEL_BATCHES) ||
    Math.max(2, Math.floor(os.cpus().length / 4));
  logger.log(`   Processing batches with parallelism: ${maxParallel}`);

  const batchFiles = [];
  const activeBatches = new Map(); // Track active batch promises

  for (let i = 0; i < batches.length; i++) {
    const batchNum = i + 1;

    // Check if already completed
    if (progress.completed_batches.includes(batchNum)) {
      const batchFile = path.join(
        BATCH_DIR,
        `${safeFileName}_batch_${batchNum}.parquet`
      );
      if (
        await fs
          .access(batchFile)
          .then(() => true)
          .catch(() => false)
      ) {
        logger.log(`   Batch ${batchNum}/${batches.length}: ✅ DONE`);
        batchFiles.push(batchFile);
        continue;
      }
    }

    // Wait if at max parallelism
    while (activeBatches.size >= maxParallel) {
      const completed = await Promise.race(Array.from(activeBatches.values()));
      activeBatches.delete(completed.batchNum);
    }

    // Start new batch
    const batchPromise = processBatchWithDuckDB(
      batches[i],
      batchNum,
      traitName,
      batches.length,
      pgsMetadata,
      logger
    )
      .then(batchFile => {
        batchFiles.push(batchFile);
        progress.completed_batches.push(batchNum);
        return fs
          .writeFile(progressFile, JSON.stringify(progress, null, 2))
          .then(() => ({ batchNum, batchFile }));
      })
      .catch(error => {
        logger.log(
          `❌ Batch ${batchNum}/${batches.length} failed: ${error.message}`
        );
        throw error;
      });

    activeBatches.set(batchNum, batchPromise);
  }

  // Wait for all remaining batches
  if (activeBatches.size > 0) {
    await Promise.all(Array.from(activeBatches.values()));
  }

  const finalFile = await mergeBatchResults(batchFiles, traitName);

  for (const filePath of batchFiles) {
    try {
      await fs.unlink(filePath);
    } catch {
      /* ignore */
    }
  }

  const finalStats = await fs.stat(finalFile);
  console.log(
    `✅ Merge complete: ${finalFile} (${(finalStats.size / 1024 / 1024).toFixed(1)}MB)`
  );

  try {
    await fs.unlink(progressFile);
  } catch {
    /* ignore */
  }

  const validation = await validateParquetFile(finalFile);
  let actualVariantCount = validation.variantCount;

  logger.log(`🎯 ${traitTitle} (${traitName}) processing complete!`);
  logger.log(`   File: ${validation.fileName}`);
  logger.log(`   Size: ${(validation.size / 1024 / 1024).toFixed(1)}MB`);
  logger.log(`   Variants: ${actualVariantCount.toLocaleString()}`);
  logger.close();

  return {
    timestamp: new Date().toISOString(),
    variant_count: actualVariantCount,
    fileName: validation.fileName
  };
}
