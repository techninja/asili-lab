/**
 * Export trait packs as .asili archives (per-chromosome parquets in a tar).
 *
 * Reads every parquet in data_out/packs/, splits by chromosome,
 * and writes {trait_id}_hg38.asili into data_out/packs/asili/.
 */

import fs from 'fs/promises';
import { mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { buildAsiliArchive, fileSizeMB } from '../../core/src/utils/asili-archive.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve('data_out');
const PACKS_DIR = path.join(OUTPUT_DIR, 'packs');
const ASILI_DIR = path.join(PACKS_DIR, 'asili');

/**
 * Export all (or one) trait pack parquets to .asili archives.
 * @param {string} [singleTraitId] — if set, only export this trait
 */
export async function exportTraitPacksAsili(singleTraitId) {
  mkdirSync(ASILI_DIR, { recursive: true });

  let parquetFiles = readdirSync(PACKS_DIR).filter(f => f.endsWith('.parquet'));

  if (singleTraitId) {
    const safe = singleTraitId.replace(/:/g, '_');
    parquetFiles = parquetFiles.filter(f => f.startsWith(safe));
  }

  if (parquetFiles.length === 0) {
    console.log('⚠️  No trait pack parquets found to export');
    return;
  }

  console.log(`📦 Exporting ${parquetFiles.length} trait pack(s) to .asili...`);

  for (const file of parquetFiles) {
    const traitId = path.basename(file, '_hg38.parquet');
    const inputPath = path.join(PACKS_DIR, file);
    const outputPath = path.join(ASILI_DIR, `${traitId}_hg38.asili`);

    // Skip if .asili is newer than source parquet
    try {
      const [srcStat, dstStat] = await Promise.all([
        fs.stat(inputPath),
        fs.stat(outputPath)
      ]);
      if (dstStat.mtimeMs > srcStat.mtimeMs) {
        console.log(`  ✓ ${traitId} — up to date`);
        continue;
      }
    } catch { /* dest doesn't exist, rebuild */ }

    const { totalVariants, chromosomes } = buildAsiliArchive({
      inputPath,
      outputPath,
      format: 'asili-trait-v1',
      meta: { traitId: traitId.replace(/_/g, ':') }
    });

    const chrCount = Object.keys(chromosomes).length;
    console.log(`  ✅ ${traitId} — ${totalVariants.toLocaleString()} variants across ${chrCount} chromosomes (${fileSizeMB(outputPath)} MB)`);
  }

  console.log('✓ Trait pack .asili export complete');
}
