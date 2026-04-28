#!/usr/bin/env node
/**
 * Generate score distribution histograms for each PGS.
 *
 * Uses the already-computed TOPMed mean/SD (from calc-pgs-refstats) to generate
 * analytical histogram bins from the normal distribution N(mean, sd²).
 *
 * Under Hardy-Weinberg equilibrium, the PGS score distribution is approximately
 * normal, so we compute the PDF directly rather than simulating.
 *
 * Output: updates data_out/pgs_norm_params.json with `d` (density) array.
 * Bins are reconstructable: lo = m - 4*s, hi = m + 4*s, 25 equal-width bins.
 *
 * Usage:
 *   node scripts/generate-score-distributions.js
 *   node scripts/generate-score-distributions.js --bins 30
 */
import '../packages/pipeline/lib/env.js';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const NORM_PARAMS_PATH = path.join(ROOT, 'data_out', 'pgs_norm_params.json');
const NUM_BINS = parseInt(process.argv.find(a => /^\d+$/.test(a)) || '0') ||
  (process.argv.includes('--bins') ? parseInt(process.argv[process.argv.indexOf('--bins') + 1]) : 25);

/** Normal PDF */
function normalPDF(x, mean, sd) {
  const z = (x - mean) / sd;
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
}

/**
 * Generate density values for a normal distribution N(mean, sd²).
 * Covers mean ± 4σ in numBins equal-width bins.
 *
 * We only store the density array — bins are reconstructable from m, s, and
 * the convention: lo = m - 4*s, hi = m + 4*s, numBins bins.
 * This cuts output size by ~50% vs storing bins + density.
 */
function generateDensity(mean, sd, numBins) {
  const lo = mean - 4 * sd;
  const step = (8 * sd) / numBins;
  const density = new Array(numBins);

  for (let i = 0; i < numBins; i++) {
    const mid = lo + (i + 0.5) * step;
    density[i] = +((normalPDF(mid, mean, sd)).toPrecision(3));
  }
  return density;
}

async function main() {
  if (!existsSync(NORM_PARAMS_PATH)) {
    console.error('❌ pgs_norm_params.json not found. Run pnpm pgs refstats first.');
    process.exit(1);
  }

  const normParams = JSON.parse(await readFile(NORM_PARAMS_PATH, 'utf8'));
  const total = Object.keys(normParams).length;
  let added = 0;
  let skipped = 0;

  console.log(`\n📊 Generating ${NUM_BINS}-bin score distributions for ${total} PGS...\n`);

  for (const [pgsId, entry] of Object.entries(normParams)) {
    const mean = entry.m;
    const sd = entry.s;

    if (sd === undefined || sd === null || sd <= 0) {
      skipped++;
      continue;
    }

    // Remove any stale keys from prior format
    delete entry.bins;
    delete entry.density;

    entry.d = generateDensity(mean, sd, NUM_BINS);
    added++;
  }

  await writeFile(NORM_PARAMS_PATH, JSON.stringify(normParams));

  const sizeKB = Math.round((await readFile(NORM_PARAMS_PATH)).length / 1024);
  console.log(`✅ Added histograms to ${added} PGS (${skipped} skipped, sd=0)`);
  console.log(`   Output: ${NORM_PARAMS_PATH} (${sizeKB} KB)\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
