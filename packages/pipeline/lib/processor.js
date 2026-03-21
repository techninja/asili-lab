import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import {
  initSync,
  Compression as _Compression,
  Table as _Table,
  writeParquet as _writeParquet,
  readParquet as _readParquet,
  WriterPropertiesBuilder as _WriterPropertiesBuilder
} from 'parquet-wasm/esm';
import pgsApiClient from '../pgs-api-client.js';
import {
  collectPgsMetadata as _collectPgsMetadata,
  needsUpdate,
  loadExistingManifest as _loadExistingManifest,
  collectSourceHashes as _collectSourceHashes,
  runDuckDBQuery as _runDuckDBQuery,
  createStandardSchema as _createStandardSchema,
  createStandardizedExportQuery,
  validateParquetFile,
  prepareFileForProcessing
} from './processor-core.js';
import { shouldExcludePGS } from './pgs-filter.js';
import { detectFormat, generateInsertSQL } from './harmonization.js';
import { getLDStatus } from './ld-detector.js';
import { generateLDClumpingSQL, generateClumpingSQL as _generateClumpingSQL, shouldClumpPGS } from './ld-clumping.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '..', '..', '..', 'data_out');
const PACKS_DIR = path.join(OUTPUT_DIR, 'packs');
const TEMP_SQL_DIR = path.join(OUTPUT_DIR, 'temp_sql');
const gunzipAsync = promisify(gunzip);

// Initialize WASM module synchronously with new API
const wasmPath = './node_modules/parquet-wasm/esm/parquet_wasm_bg.wasm';
const wasmBuffer = await fs.readFile(wasmPath);
initSync({ module: wasmBuffer });

async function streamProcessWithDuckDB(traitName, config) {
  console.log(`  - ${traitName}: Streaming process with DuckDB...`);

  const safeFileName = traitName.replace(':', '_');
  const outputPath = path.join(PACKS_DIR, `${safeFileName}_hg38.parquet`);
  
  // Use LARGE_TMP for database if available to avoid filling up main disk
  const dbDir = process.env.LARGE_TMP || OUTPUT_DIR;
  const dbPath = path.join(dbDir, `${safeFileName}.duckdb`);
  const { execSync } = await import('child_process');

  // Check if we can resume from existing database
  let resuming = false;
  console.log(`    Checking for existing database: ${dbPath}`);

  try {
    await fs.access(dbPath);
    console.log('    Database file exists, checking contents...');

    const checkSQL =
      'SELECT COUNT(*) as count, COUNT(DISTINCT pgs_id) as pgs_count FROM pgs_staging;';
    const checkFile = path.join(OUTPUT_DIR, 'check.sql');
    await fs.writeFile(checkFile, checkSQL);

    const result = execSync(`duckdb ${dbPath} < ${checkFile}`, {
      cwd: OUTPUT_DIR,
      stdio: 'pipe',
      encoding: 'utf8'
    });

    const existingVariants = parseInt(
      result.match(/│\s*(\d+)\s*│/)?.[1] || '0'
    );
    const existingPgsCount = parseInt(
      result.match(/│\s*\d+\s*│\s*(\d+)\s*│/)?.[1] || '0'
    );

    await fs.unlink(checkFile);

    console.log(
      `    Database contains ${existingVariants} variants from ${existingPgsCount} PGS scores`
    );

    if (existingVariants > 0) {
      console.log('    ✓ Resuming from existing database');
      resuming = true;
    } else {
      console.log('    Database is empty, starting fresh');
    }
  } catch (error) {
    console.log(`    No existing database found: ${error.message}`);
  }

  if (!resuming) {
    // Clear and recreate temp SQL directory and ensure packs directory exists
    try {
      await fs.rm(TEMP_SQL_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
    await fs.mkdir(TEMP_SQL_DIR, { recursive: true });
    await fs.mkdir(PACKS_DIR, { recursive: true });

    // Initialize DuckDB with staging schema
    const memoryLimit = process.env.DUCKDB_MEMORY_LIMIT || '8GB';
    const threads = process.env.DUCKDB_THREADS || Math.max(4, Math.floor(os.cpus().length / 2));
    const tempDir = process.env.LARGE_TMP || '/tmp';
    
    const initSQL = `
            PRAGMA memory_limit='${memoryLimit}';
            PRAGMA threads=${threads};
            PRAGMA temp_directory='${tempDir}';
            
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
        `;

    const initFile = path.join(OUTPUT_DIR, 'init.sql');
    await fs.writeFile(initFile, initSQL);

    console.log('    Initializing DuckDB database with optimized settings...');
    const duckdbCmd = process.env.DUCKDB_CLI || 'duckdb';
    execSync(`${duckdbCmd} ${dbPath} < ${initFile}`, {
      cwd: OUTPUT_DIR,
      stdio: 'pipe'
    });
    console.log('    ✓ Database initialized');

    await fs.unlink(initFile);
  } else {
    console.log('    Resuming from existing database...');
  }

  try {
    let totalVariants = 0;
    const pgsIds = [];
    const pgsMetadata = new Map();

    // Stream each PGS file directly into DuckDB
    for (const pgsId of config.pgs_ids) {
      // Check if this PGS should be excluded
      try {
        const scoreData = await pgsApiClient.getScore(pgsId);
        const filterResult = await shouldExcludePGS(pgsId, scoreData, pgsApiClient);
        if (filterResult.exclude) {
          console.log(`        Excluding ${pgsId}: ${filterResult.reason}`);
          continue;
        }
        
        // Store LD metadata
        const ldStatus = getLDStatus(scoreData);
        pgsMetadata.set(pgsId, { ...scoreData, ...ldStatus });
      } catch (error) {
        console.log(`        Error checking ${pgsId} metadata: ${error.message}`);
      }
      
      // Check if this PGS is already processed
      if (resuming) {
        console.log(`        Checking if ${pgsId} already processed...`);

        const checkSQL = `SELECT COUNT(*) as count FROM pgs_staging WHERE pgs_id = '${pgsId}';`;
        const checkFile = path.join(OUTPUT_DIR, 'check_pgs.sql');
        await fs.writeFile(checkFile, checkSQL);

        const result = execSync(`duckdb ${dbPath} < ${checkFile}`, {
          cwd: OUTPUT_DIR,
          stdio: 'pipe',
          encoding: 'utf8'
        });

        const existingCount = parseInt(
          result.match(/│\s*(\d+)\s*│/)?.[1] || '0'
        );
        await fs.unlink(checkFile);

        console.log(
          `        ${pgsId}: ${existingCount} variants found in database`
        );

        if (existingCount > 0) {
          console.log(`        ✓ Skipping ${pgsId} (already processed)`);
          totalVariants += existingCount;
          pgsIds.push(pgsId);
          continue;
        } else {
          console.log(`        Processing ${pgsId} (not in database)`);
        }
      }

      console.log(`        Streaming ${pgsId} into DuckDB...`);

      try {
        const scoreData = await pgsApiClient.getScore(pgsId);
        if (!scoreData.ftp_scoring_file) {
          console.log('        No scoring file found, skipping');
          continue;
        }

        const url = scoreData.ftp_scoring_file;
        const filePath = await pgsApiClient.downloadPGSFile(pgsId, url);

        // Decompress file for DuckDB (workaround for .gz reading issues)
        const buffer = await fs.readFile(filePath);
        const content = await gunzipAsync(buffer);
        const uncompressedPath = filePath.replace('.gz', '.tsv');
        await fs.writeFile(uncompressedPath, content);

        // Prepare file for processing
        const { columns, dataOnlyPath, dataLineCount } =
          await prepareFileForProcessing(filePath);

        console.log(
          `        Created data-only file with ${dataLineCount} rows`
        );

        if (dataLineCount === 0) {
          console.log('        No data found, skipping');
          continue;
        }

        // Detect format and generate harmonized SQL
        const formatType = detectFormat(columns);

        if (!formatType) {
          console.log(
            `        Unsupported format - columns: ${columns.join(', ')}`
          );
          continue;
        }

        console.log(`        Detected ${formatType} format`);

        const importSQL = generateInsertSQL(
          formatType,
          columns,
          dataOnlyPath,
          pgsId,
          config,
          traitName
        );

        const sqlFile = path.join(TEMP_SQL_DIR, `import_${pgsId}.sql`);
        await fs.writeFile(sqlFile, importSQL);

        console.log(`        Importing ${pgsId} data into DuckDB...`);
        const duckdbCmd = process.env.DUCKDB_CLI || 'duckdb';
        try {
          execSync(`${duckdbCmd} ${dbPath} < ${sqlFile}`, {
            cwd: OUTPUT_DIR,
            stdio: 'pipe',
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024 // 50MB buffer
          });
          console.log('        ✓ Import complete');
        } catch (error) {
          console.log(`        INSERT ERROR: ${error.message}`);
          console.log(`        STDERR: ${error.stderr}`);
          console.log(`        STDOUT: ${error.stdout}`);
        }

        // Get count
        const countSQL = `SELECT COUNT(*) as count FROM pgs_staging WHERE pgs_id = '${pgsId}';`;
        const countFile = path.join(TEMP_SQL_DIR, `count_${pgsId}.sql`);
        await fs.writeFile(countFile, countSQL);

        const result = execSync(`${duckdbCmd} ${dbPath} < ${countFile}`, {
          cwd: OUTPUT_DIR,
          stdio: 'pipe',
          encoding: 'utf8'
        });

        const variantCount = parseInt(
          result.match(/│\s*(\d+)\s*│/)?.[1] || '0'
        );
        console.log(`        Added ${variantCount} variants`);

        totalVariants += variantCount;
        pgsIds.push(pgsId);
        await fs.unlink(countFile);
      } catch (error) {
        console.log(`        Error processing ${pgsId}: ${error.message}`);
      }
    }

    if (totalVariants === 0) {
      console.log(`  - Skipped (no variants found)`);
      await fs.unlink(dbPath);
      return { totalVariants: 0, fileName: null, pgsIds: [] };
    }

    // Apply LD clumping if needed (per chromosome for LD data)
    let clumpedCount = 0;
    const chromosomes = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22'];
    
    for (const [pgsId, metadata] of pgsMetadata.entries()) {
      if (shouldClumpPGS(metadata)) {
        console.log(`    Applying LD clumping to ${pgsId}...`);
        
        // Get count before clumping
        const beforeSQL = `SELECT COUNT(*) as count FROM pgs_staging WHERE pgs_id = '${pgsId}';`;
        const beforeFile = path.join(OUTPUT_DIR, `count_before_${pgsId}.sql`);
        await fs.writeFile(beforeFile, beforeSQL);
        
        const beforeResult = execSync(`duckdb ${dbPath} < ${beforeFile}`, {
          cwd: OUTPUT_DIR,
          stdio: 'pipe',
          encoding: 'utf8'
        });
        
        const beforeCount = parseInt(beforeResult.match(/│\s*(\d+)\s*│/)?.[1] || '0');
        await fs.unlink(beforeFile);
        
        for (const chr of chromosomes) {
          const clumpSQL = generateLDClumpingSQL('pgs_staging', chr);
          const clumpFile = path.join(OUTPUT_DIR, `clump_${pgsId}_chr${chr}.sql`);
          await fs.writeFile(clumpFile, clumpSQL);
          
          try {
            execSync(`duckdb ${dbPath} < ${clumpFile}`, {
              cwd: OUTPUT_DIR,
              stdio: 'pipe'
            });
            await fs.unlink(clumpFile);
          } catch (error) {
            console.log(`    ⚠ Clumping failed for ${pgsId} chr${chr}: ${error.message}`);
            await fs.unlink(clumpFile).catch(() => {});
          }
        }
        
        // Get new count after clumping all chromosomes
        const countSQL = `SELECT COUNT(*) as count FROM pgs_staging WHERE pgs_id = '${pgsId}';`;
        const countFile = path.join(OUTPUT_DIR, `count_clumped_${pgsId}.sql`);
        await fs.writeFile(countFile, countSQL);
        
        const result = execSync(`duckdb ${dbPath} < ${countFile}`, {
          cwd: OUTPUT_DIR,
          stdio: 'pipe',
          encoding: 'utf8'
        });
        
        const afterCount = parseInt(result.match(/│\s*(\d+)\s*│/)?.[1] || '0');
        const removed = beforeCount - afterCount;
        console.log(`    ✓ Clumped ${pgsId}: removed ${removed} variants (${afterCount} remaining)`);
        clumpedCount += removed;
        totalVariants = totalVariants - beforeCount + afterCount;
        
        await fs.unlink(countFile);
      }
    }
    
    if (clumpedCount > 0) {
      console.log(`    ✓ Total variants removed by LD clumping: ${clumpedCount}`);
    }

    // Export to final parquet with ZSTD compression
    console.log('    Enforcing standard schema...');
    const exportSQL = createStandardizedExportQuery('pgs_staging', outputPath, config.normalization_params);

    const exportFile = path.join(OUTPUT_DIR, 'export.sql');
    await fs.writeFile(exportFile, exportSQL);

    console.log(`    Exporting to Parquet (${totalVariants} variants)...`);

    try {
      execSync(`duckdb ${dbPath} < ${exportFile}`, {
        cwd: OUTPUT_DIR,
        stdio: 'pipe'
      });
      console.log('    ✓ Export complete');
    } catch (error) {
      console.log(`    Export ERROR: ${error.message}`);
      throw error;
    }

    // Also export to unified SQLite DB for fast refstats

    // Verify the parquet file was created
    try {
      const validation = await validateParquetFile(outputPath);
      console.log(
        `    ✓ Parquet file created: ${validation.size} bytes, ${validation.variantCount} variants`
      );
    } catch (error) {
      console.log(`    ⚠ Could not verify parquet file: ${error.message}`);
      throw new Error(`Parquet export failed: ${error.message}`);
    }

    // Cleanup
    await fs.unlink(exportFile);

    // Clean up any remaining temp files
    try {
      const files = await fs.readdir(OUTPUT_DIR);
      for (const file of files) {
        if (
          file.includes(safeFileName) &&
          (file.endsWith('.sql') ||
            file.endsWith('.tsv') ||
            file.endsWith('_data.tsv'))
        ) {
          await fs.unlink(path.join(OUTPUT_DIR, file));
        }
      }
    } catch { /* ignore */ }

    // Only remove DB after successful completion
    try {
      await fs.unlink(dbPath);
    } catch { /* ignore */ }

    console.log(`  - Created unified file (${totalVariants} variants)`);
    return {
      totalVariants,
      fileName: `${safeFileName}_hg38.parquet`,
      pgsIds
    };
  } catch (error) {
    console.log(`  - DuckDB streaming failed: ${error.message}`);

    // Clean up on failure but keep DB for debugging
    try {
      const files = await fs.readdir(OUTPUT_DIR);
      for (const file of files) {
        if (
          file.includes(safeFileName) &&
          (file.endsWith('.sql') ||
            file.endsWith('.tsv') ||
            file.endsWith('_data.tsv'))
        ) {
          await fs.unlink(path.join(OUTPUT_DIR, file));
        }
      }
    } catch { /* ignore */ }

    throw error;
  }
}

export { shouldExcludePGS } from './pgs-filter.js';

import { generateTraitPackBatched } from './batched-processor.js';

export async function generateTraitPack(traitName, config, allMetadataCache = null) {
  // Check if we should use batched processing for large datasets
  if (
    config.pgs_ids.length > 10 ||
    (config.expected_variants && config.expected_variants > 1000000)
  ) {
    console.log(
      `  - Using batched processing for ${traitName} (${config.pgs_ids.length} PGS files)`
    );
    return await generateTraitPackBatched(traitName, config, allMetadataCache);
  }

  // Use original processing for smaller datasets
  return await generateTraitPackOriginal(traitName, config, allMetadataCache);
}

async function generateTraitPackOriginal(traitName, config, _allMetadataCache = null) {
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

  console.log(`  - Generating ${traitName}...`);

  const result = await streamProcessWithDuckDB(traitName, config);

  return {
    timestamp: new Date().toISOString(),
    variant_count: result?.totalVariants || 0,
    fileName: result?.fileName || null
  };
}
