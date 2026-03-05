#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadTraitCatalog, getTraitConfigs } from './lib/catalog.js';
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
    // Load trait catalog
    logger.log('📋 Loading trait catalog...');
    const catalog = await loadTraitCatalog();
    const traitConfigs = await getTraitConfigs(catalog);

    logger.log(`📊 Processing ${Object.keys(traitConfigs).length} traits`);
    logger.log('');

    // Filter to single trait if specified
    let sortedTraits = Object.entries(traitConfigs).sort(
      ([, a], [, b]) => Number(b.expected_variants || 0) - Number(a.expected_variants || 0)
    );

    if (process.env.SINGLE_TRAIT) {
      sortedTraits = sortedTraits.filter(([traitName, config]) =>
        traitName === process.env.SINGLE_TRAIT || config.trait_id === process.env.SINGLE_TRAIT
      );
      if (sortedTraits.length === 0) {
        logger.error(`❌ Trait not found: ${process.env.SINGLE_TRAIT}`);
        logger.close();
        process.exit(1);
      }
      logger.log(`🎯 Processing single trait: ${process.env.SINGLE_TRAIT}`);
      logger.log('');
    }

    for (const [traitName, config] of sortedTraits) {
      const displayName = `${config.name || config.title || traitName} (${config.trait_id || traitName})`;
      const traitStartTime = Date.now();

      try {
        logger.log(`🔄 Processing: ${displayName}`);
        const result = await generateTraitPack(traitName, config, {});

        if (!result.metadata_only) {
          logger.log(
            `   ✅ Generated ${displayName} (${result.variant_count} variants, ${Math.round((Date.now() - traitStartTime) / 1000)}s)`
          );
        } else {
          logger.log(
            `   ✅ Skipped ${displayName} - up to date (${Math.round((Date.now() - traitStartTime) / 1000)}s)`
          );
        }

        processedCount++;
        logger.log('');
      } catch (error) {
        const traitDuration = Math.round((Date.now() - traitStartTime) / 1000);
        logger.error(
          `   ❌ Error processing ${displayName}: ${error.message} (${traitDuration}s)`
        );
        errors.push({
          trait_id: config.trait_id || traitName,
          title: config.title || config.name || traitName,
          error: error.message,
          duration: traitDuration
        });
        errorCount++;
        logger.log('');
      }
    }

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
      logger.log(`🔍 Scanning parquet file for ${process.env.SINGLE_TRAIT}...`);
      await scanParquetPGS(process.env.SINGLE_TRAIT);
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
