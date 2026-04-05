#!/usr/bin/env node

import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTraitConfigs } from './lib/catalog.js';
import { generateTraitPack } from './lib/processor.js';
import { closeManifestConnection } from './lib/trait-manifest.js';
import { exportTraitManifestJSON } from './lib/export-manifest.js';
import scanParquetPGS from './scan-parquet-pgs.js';
import { createLogger } from '../core/src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const logger = createLogger('etl-orchestrator');

  logger.log('🧬 Asili ETL Pipeline Starting...');
  logger.log('=====================================');

  const startTime = Date.now();
  let processedCount = 0;
  let errorCount = 0;
  const errors = [];

  try {
    const tier = process.env.ASILI_TIER || 'tier1_public';
    logger.log(`📋 Loading traits (tier: ${tier})...`);
    const traitConfigs = await getTraitConfigs(tier);

    logger.log(`📊 Processing ${Object.keys(traitConfigs).length} traits`);
    logger.log('');

    let sortedTraits = Object.entries(traitConfigs).sort(
      ([, a], [, b]) =>
        Number(b.expected_variants || 0) - Number(a.expected_variants || 0)
    );

    if (process.env.SINGLE_TRAIT) {
      const requested = process.env.SINGLE_TRAIT.split(',').map(s => s.trim());
      sortedTraits = sortedTraits.filter(
        ([traitName, config]) =>
          requested.includes(traitName) || requested.includes(config.trait_id)
      );
      if (sortedTraits.length === 0) {
        logger.error(
          `❌ No traits found matching: ${process.env.SINGLE_TRAIT}`
        );
        logger.close();
        process.exit(1);
      }
      logger.log(
        `🎯 Processing ${sortedTraits.length} trait(s): ${requested.join(', ')}`
      );
      logger.log('');
    }

    // Concurrent trait processing with bounded parallelism
    const maxConcurrent =
      parseInt(process.env.MAX_PARALLEL_TRAITS) ||
      Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
    logger.log(`⚡ Trait concurrency: ${maxConcurrent}`);
    logger.log('');

    const active = new Set();
    const _results = [];

    for (const [traitName, config] of sortedTraits) {
      // Wait if at capacity
      while (active.size >= maxConcurrent) {
        await Promise.race(active);
      }

      const displayName = `${config.name || config.title || traitName} (${config.trait_id || traitName})`;

      const task = (async () => {
        const traitStartTime = Date.now();
        try {
          logger.log(`🔄 Processing: ${displayName}`);
          const result = await generateTraitPack(traitName, config, {});
          const dur = Math.round((Date.now() - traitStartTime) / 1000);

          if (!result.metadata_only) {
            logger.log(
              `   ✅ Generated ${displayName} (${result.variant_count} variants, ${dur}s)`
            );
          } else {
            logger.log(`   ✅ Skipped ${displayName} - up to date (${dur}s)`);
          }
          processedCount++;
        } catch (error) {
          const dur = Math.round((Date.now() - traitStartTime) / 1000);
          logger.error(
            `   ❌ Error processing ${displayName}: ${error.message} (${dur}s)`
          );
          errors.push({
            trait_id: config.trait_id || traitName,
            title: config.title || config.name || traitName,
            error: error.message,
            duration: dur
          });
          errorCount++;
        }
        logger.log('');
      })();

      const tracked = task.then(
        () => active.delete(tracked),
        () => active.delete(tracked)
      );
      active.add(tracked);
    }

    // Drain remaining
    await Promise.allSettled(active);

    // Summary
    const totalDuration = Math.round((Date.now() - startTime) / 1000);
    const minutes = Math.floor(totalDuration / 60);
    const seconds = totalDuration % 60;
    const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    logger.log('=====================================');
    logger.log('🎉 ETL Pipeline Complete!');
    logger.log(`📈 Processed: ${processedCount} traits`);
    logger.log(`⚠️  Errors: ${errorCount} traits`);
    logger.log(`⏱️  Total Duration: ${durationStr}`);

    // Export JSON manifest for frontend
    logger.log('');
    logger.log('📦 Exporting JSON manifest...');
    await exportTraitManifestJSON();

    // Scan parquet files and populate pgs_scores
    if (process.env.SINGLE_TRAIT) {
      const requested = process.env.SINGLE_TRAIT.split(',').map(s => s.trim());
      for (const traitId of requested) {
        logger.log(`🔍 Scanning parquet file for ${traitId}...`);
        await scanParquetPGS(traitId);
      }
    } else {
      logger.log('🔍 Scanning parquet files for all PGS...');
      await scanParquetPGS();
    }

    if (errors.length > 0) {
      logger.log('');
      logger.log('❌ ERROR SUMMARY:');
      logger.log('==================');
      for (const err of errors) {
        logger.log(
          `   ${err.trait_id} (${err.title}): ${err.error} (${err.duration}s)`
        );
      }
    }

    logger.log('🚀 Trait packs ready for serving');
    logger.close();

    if (errorCount > 0) {
      process.exit(1);
    }
  } catch (error) {
    logger.error('💥 Pipeline failed:', error.message);
    logger.error(error.stack);
    logger.close();
    process.exit(1);
  } finally {
    // Close database connection
    await closeManifestConnection();
  }
}

main().catch(console.error);
