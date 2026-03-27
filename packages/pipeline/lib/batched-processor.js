import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { spawn } from 'child_process';
import pgsApiClient from '../pgs-api-client.js';
import {
  collectPgsMetadata as _collectPgsMetadata,
  needsUpdate,
  collectSourceHashes as _collectSourceHashes,
  countVariantsInFile,
  runDuckDBQuery as _runDuckDBQuery,
  validateParquetFile,
  prepareFileForProcessing
} from './processor-core.js';
import {
  detectFormat,
  generateColumnExpressions,
  getColumnRef,
  generateColumnDefinitions,
  FORMAT_TYPES
} from './harmonization.js';
import { shouldClumpPGS, generateClumpingSQL } from './ld-clumping.js';
import { execSync } from 'child_process';
import { createLogger } from '../../core/src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR =
  process.env.OUTPUT_DIR || path.join(__dirname, '..', '..', '..', 'data_out');
const BATCH_DIR = path.join(OUTPUT_DIR, 'batches');
const PACKS_DIR = path.join(OUTPUT_DIR, 'packs');
const _gunzipAsync = promisify(gunzip);

import os from 'os';

// Ensure batch directory exists
await fs.mkdir(BATCH_DIR, { recursive: true });
await fs.mkdir(PACKS_DIR, { recursive: true });

async function createBatches(pgsIds, maxVariantsPerBatch = null) {
  console.log(`📦 Analyzing ${pgsIds.length} PGS files for batching...`);

  // Larger batches for native execution with more memory
  if (!maxVariantsPerBatch) {
    if (pgsIds.length > 80) {
      maxVariantsPerBatch = 50000; // Larger batches for huge datasets
    } else if (pgsIds.length > 60) {
      maxVariantsPerBatch = 75000;
    } else if (pgsIds.length > 40) {
      maxVariantsPerBatch = 100000;
    } else {
      maxVariantsPerBatch = 150000; // Much larger default
    }
  }

  console.log(
    `    Using batch size: ${maxVariantsPerBatch.toLocaleString()} variants per batch`
  );

  // Get actual variant counts from cached files (parallel)
  const fileInfo = [];
  const downloadPromises = [];

  for (const pgsId of pgsIds) {
    const promise = (async () => {
      try {
        // Always go through downloadPGSFile which handles harmonized preference + caching
        const scoreData = await pgsApiClient.getScore(pgsId);
        if (!scoreData.ftp_scoring_file) {
          console.log(`    ${pgsId}: No scoring file, skipping`);
          return null;
        }

        const filePath = await pgsApiClient.downloadPGSFile(
          pgsId,
          scoreData.ftp_scoring_file
        );
        if (!filePath) {
          console.log(`    ${pgsId}: Download failed, skipping`);
          return null;
        }

        const variantCount = await countVariantsInFile(filePath);

        return {
          pgs_id: pgsId,
          file_path: filePath,
          variants: variantCount,
          url: scoreData.ftp_scoring_file
        };
      } catch (error) {
        console.log(`    ${pgsId}: Error - ${error.message}`);
        return null;
      }
    })();

    downloadPromises.push(promise);
  }

  // Process downloads in parallel batches to avoid overwhelming the API
  const batchSize = 10;
  console.log(`    Downloading and analyzing in batches of ${batchSize}...`);

  for (let i = 0; i < downloadPromises.length; i += batchSize) {
    const batch = downloadPromises.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(downloadPromises.length / batchSize);

    console.log(
      `    Batch ${batchNum}/${totalBatches}: Processing ${batch.length} files...`
    );
    const results = await Promise.all(batch);

    let successCount = 0;
    for (const result of results) {
      if (result) {
        fileInfo.push(result);
        successCount++;
      }
    }
    console.log(
      `    Batch ${batchNum}/${totalBatches}: ✓ ${successCount}/${batch.length} files ready`
    );
  }

  console.log(
    `    ✓ Total: ${fileInfo.length}/${pgsIds.length} files ready for processing`
  );
  console.log(
    `    Total variants: ${fileInfo.reduce((sum, f) => sum + f.variants, 0).toLocaleString()}`
  );
  console.log('');

  // Create batches based on variant counts
  const batches = [];
  let currentBatch = [];
  let currentCount = 0;

  for (const file of fileInfo) {
    if (
      currentCount + file.variants > maxVariantsPerBatch &&
      currentBatch.length > 0
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentCount = 0;
    }

    currentBatch.push(file);
    currentCount += file.variants;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

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
      const { columns, dataOnlyPath, dataLineCount } =
        await prepareFileForProcessing(file.file_path);

      if (dataLineCount === 0) continue;

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
      const columnDefs = generateColumnDefinitions(columns);
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
            FROM read_csv('${dataOnlyPath}', delim='\t', header=false, columns={${columnDefs}}) csv
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
        fileQueries.push(`
            -- Process ${file.pgs_id} (${formatType} format, ${columns.length} columns)
            INSERT INTO batch_variants
            SELECT 
                ${expressions.variant_id} as variant_id,
                ${expressions.effect_allele} as effect_allele,
                ${expressions.effect_weight} as effect_weight,
                '${file.pgs_id}' as pgs_id
            FROM read_csv('${dataOnlyPath}', delim='\t', header=false, columns={${columnDefs}})
            WHERE ${expressions.effect_allele} IS NOT NULL 
              AND ${expressions.effect_allele} != ''
              AND ${weightCol} IS NOT NULL
              AND ${weightCol} != '';
            `);
      }
    } catch (error) {
      logger.log(
        `    Warning: Could not prepare ${file.pgs_id}: ${error.message}`
      );
    }
  }

  // Create DuckDB subprocess to avoid memory issues
  const CLUMP_WINDOW = 250000;
  const MIN_VARIANTS_AFTER_CLUMP = 8;
  const clumpingSQL = Array.from(pgsMetadata.entries())
    .filter(
      ([pgsId, meta]) =>
        batch.some(f => f.pgs_id === pgsId) && shouldClumpPGS(meta)
    )
    .map(([pgsId]) => {
      logger.log(`    🔧 Clumping ${pgsId} in batch ${batchNum}`);
      return `
        -- Clump ${pgsId}
        DELETE FROM batch_variants 
        WHERE (variant_id, pgs_id) IN (
          SELECT variant_id, pgs_id FROM (
            SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY pgs_id,
                  SPLIT_PART(variant_id, ':', 1),
                  FLOOR(TRY_CAST(SPLIT_PART(variant_id, ':', 2) AS BIGINT) / ${CLUMP_WINDOW})
                ORDER BY ABS(effect_weight) DESC
              ) as rank_in_window,
              ROW_NUMBER() OVER (
                PARTITION BY pgs_id
                ORDER BY ABS(effect_weight) DESC
              ) as global_rank
            FROM batch_variants
            WHERE pgs_id = '${pgsId}'
          ) WHERE rank_in_window > 1
            AND global_rank > ${MIN_VARIANTS_AFTER_CLUMP}
        );`;
    })
    .join('\n');

  const clumpCount = Array.from(pgsMetadata.entries()).filter(
    ([pgsId, meta]) =>
      batch.some(f => f.pgs_id === pgsId) && shouldClumpPGS(meta)
  ).length;
  if (clumpingSQL) {
    logger.log(
      `    📊 Applying LD clumping to ${clumpCount} PGS in this batch`
    );
    logger.log(
      `    📝 Generated ${clumpingSQL.split('\n').filter(l => l.trim().startsWith('--')).length} clumping SQL statements`
    );
  } else {
    logger.log(`    ⏭️  No LD clumping needed for this batch`);
  }

  const duckdbScript = `
        DROP TABLE IF EXISTS batch_variants;
        
        CREATE TABLE batch_variants (
            variant_id VARCHAR,
            effect_allele VARCHAR,
            effect_weight DOUBLE,
            pgs_id VARCHAR
        );
        
        ${fileQueries.join('\n')}
        
        -- Apply LD clumping per PGS if needed
        ${clumpingSQL}
        
        -- Enforce standard schema with chr/pos integer columns
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
            TRY_CAST(SPLIT_PART(COALESCE(variant_id, ''), ':', 2) AS INTEGER) AS pos
        FROM batch_variants
        WHERE variant_id IS NOT NULL AND variant_id != ''
          AND effect_allele IS NOT NULL AND effect_allele != ''
          AND effect_weight IS NOT NULL;
        
        -- Export batch results
        COPY (
            SELECT DISTINCT 
                variant_id,
                effect_allele,
                effect_weight,
                pgs_id,
                chr,
                pos
            FROM batch_variants_standardized 
            ORDER BY variant_id
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

  // Filter out any undefined or invalid file paths
  const validBatchFiles = batchFiles.filter(filePath => {
    if (!filePath || typeof filePath !== 'string') {
      console.log(`    Warning: Skipping invalid batch file path: ${filePath}`);
      return false;
    }
    return true;
  });

  if (validBatchFiles.length === 0) {
    throw new Error('No valid batch files to merge');
  }

  console.log(`    Merging ${validBatchFiles.length} valid batch files`);

  const safeFileName = traitName.replace(':', '_');
  const finalOutputPath = path.join(PACKS_DIR, `${safeFileName}_hg38.parquet`);

  // For large numbers of files, use hierarchical merge to avoid memory issues
  if (validBatchFiles.length > 5) {
    return await hierarchicalMerge(
      validBatchFiles,
      finalOutputPath,
      safeFileName
    );
  }

  // Direct append for smaller datasets
  try {
    return await directAppend(validBatchFiles, finalOutputPath, safeFileName);
  } catch (error) {
    console.log(`   DEBUG: directAppend failed: ${error.message}`);
    throw error;
  }
}

async function hierarchicalMerge(batchFiles, finalOutputPath, safeFileName) {
  console.log(`📊 Using hierarchical append for ${batchFiles.length} files`);

  let currentFiles = [...batchFiles];
  let level = 1;

  // Append in groups of 5 to avoid command line length limits and memory issues
  while (currentFiles.length > 5) {
    console.log(
      `   Level ${level}: Appending ${currentFiles.length} files into groups of 5`
    );
    const nextLevelFiles = [];

    for (let i = 0; i < currentFiles.length; i += 5) {
      const group = currentFiles.slice(i, i + 5);
      const groupOutputPath = path.join(
        BATCH_DIR,
        `${safeFileName}_level${level}_group${Math.floor(i / 5)}.parquet`
      );

      await directAppend(
        group,
        groupOutputPath,
        `${safeFileName}_level${level}_group${Math.floor(i / 5)}`
      );
      nextLevelFiles.push(groupOutputPath);

      // Cleanup input files
      for (const filePath of group) {
        try {
          await fs.unlink(filePath);
        } catch {
          /* ignore */
        }
      }
    }

    currentFiles = nextLevelFiles;
    level++;
  }

  // Final append
  console.log(`   Final append: ${currentFiles.length} files`);
  return await directAppend(currentFiles, finalOutputPath, safeFileName);
}

async function directAppend(batchFiles, outputPath, _baseName) {
  console.log(
    `    Direct append: ${batchFiles.length} files -> ${path.basename(outputPath)}`
  );

  const validFiles = [];
  for (const filePath of batchFiles) {
    try {
      await fs.access(filePath);
      const stats = await fs.stat(filePath);
      if (stats.size > 0) validFiles.push(filePath);
    } catch {
      console.log(`    Warning: Skipping invalid file: ${filePath}`);
    }
  }

  if (validFiles.length === 0) {
    throw new Error('No valid batch files found');
  }

  const { execSync } = await import('child_process');
  const pythonCmd = process.env.PYTHON_CLI || 'python3';

  // Try parallel merge first
  const parallelScriptPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'merge_parquet_parallel.py'
  );

  try {
    const cmd = `${pythonCmd} ${parallelScriptPath} ${validFiles.join(' ')} ${outputPath}`;
    execSync(cmd, { cwd: OUTPUT_DIR, stdio: 'inherit' });
    console.log('    ✓ Parallel merge successful');
    return outputPath;
  } catch (error) {
    console.log(`    ⚠ Parallel merge failed: ${error.message}`);
    console.log('    Falling back to sequential merge...');

    // Fallback to sequential merge
    const sequentialScriptPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'merge_parquet.py'
    );

    try {
      const cmd = `${pythonCmd} ${sequentialScriptPath} ${validFiles.join(' ')} ${outputPath}`;
      execSync(cmd, { cwd: OUTPUT_DIR, stdio: 'inherit' });
      console.log('    ✓ Sequential merge successful');
      return outputPath;
    } catch (fallbackError) {
      throw new Error(`Both merge methods failed: ${fallbackError.message}`);
    }
  }
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
      // Read from database instead of recalculating
      const dbData = await getPGS(pgsId);
      if (dbData) {
        pgsMetadata.set(pgsId, {
          needs_clumping: dbData.needs_clumping || false,
          ld_aware: dbData.ld_aware || false
        });
        if (dbData.needs_clumping) {
          logger.log(
            `   📌 ${pgsId}: needs LD clumping (method=${dbData.method_name}, variants=${dbData.variants_number})`
          );
        }
      }
    } catch (_error) {
      logger.log(`   ⚠️  Warning: Could not get LD status for ${pgsId}`);
    }
  }

  const needsClumpingCount = Array.from(pgsMetadata.values()).filter(
    m => m.needs_clumping
  ).length;
  logger.log(
    `   📊 LD Status: ${needsClumpingCount}/${pgsMetadata.size} PGS need clumping`
  );

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

  // If validation failed to count, query directly
  if (actualVariantCount === 0) {
    try {
      const duckdbCmd = process.env.DUCKDB_CLI || 'duckdb';
      const result = execSync(
        `${duckdbCmd} -c "SELECT COUNT(*) as count FROM '${finalFile}';"`,
        { encoding: 'utf8' }
      );
      const match = result.match(/│\s*(\d+)\s*│/);
      actualVariantCount = match ? parseInt(match[1]) : 0;
    } catch {
      actualVariantCount = 0;
    }
  }

  // Calculate clumping stats
  const clumpedPGS = Array.from(pgsMetadata.entries()).filter(([_, meta]) =>
    shouldClumpPGS(meta)
  );
  let clumpingStats = '';
  if (clumpedPGS.length > 0) {
    const totalBefore = clumpedPGS.reduce((sum, [pgsId]) => {
      const batch = batches.flat().find(f => f.pgs_id === pgsId);
      return sum + (batch?.variants || 0);
    }, 0);

    try {
      const duckdbCmd = process.env.DUCKDB_CLI || 'duckdb';
      const pgsIdList = clumpedPGS.map(([id]) => `'${id}'`).join(',');
      const result = execSync(
        `${duckdbCmd} -c "SELECT COUNT(*) as total FROM '${finalFile}' WHERE pgs_id IN (${pgsIdList});"`,
        { encoding: 'utf8' }
      );
      const match = result.match(/│\s*(\d+)\s*│/);
      const totalAfter = match ? parseInt(match[1]) : 0;
      const removed = totalBefore - totalAfter;

      // Check if any PGS was completely removed
      for (const [pgsId] of clumpedPGS) {
        const countResult = execSync(
          `${duckdbCmd} -c "SELECT COUNT(*) as cnt FROM '${finalFile}' WHERE pgs_id = '${pgsId}';"`,
          { encoding: 'utf8' }
        );
        const countMatch = countResult.match(/│\s*(\d+)\s*│/);
        const afterCount = countMatch ? parseInt(countMatch[1]) : 0;

        if (afterCount === 0) {
          throw new Error(
            `LD clumping removed ALL variants from ${pgsId} - this indicates a bug in the clumping logic or data format issue`
          );
        }
      }

      clumpingStats = `\n   LD Clumping: ${clumpedPGS.length} PGS, ${totalBefore.toLocaleString()} → ${totalAfter.toLocaleString()} variants (removed ${removed.toLocaleString()})`;
    } catch (error) {
      if (error.message.includes('removed ALL variants')) {
        throw error;
      }
    }
  }

  logger.log(`🎯 ${traitTitle} (${traitName}) processing complete!`);
  logger.log(`   File: ${validation.fileName}`);
  logger.log(`   Size: ${(validation.size / 1024 / 1024).toFixed(1)}MB`);
  logger.log(
    `   Variants: ${actualVariantCount.toLocaleString()}${clumpingStats}`
  );
  logger.close();

  return {
    timestamp: new Date().toISOString(),
    variant_count: actualVariantCount,
    fileName: validation.fileName
  };
}
