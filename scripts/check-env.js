#!/usr/bin/env node
// Verify environment is ready for benchmarks
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log('🔍 Environment Check\n');

let allGood = true;

// Check GNOMAD_DB_PATH
const gnomadPath = process.env.GNOMAD_DB_PATH;
if (!gnomadPath) {
  console.log('❌ GNOMAD_DB_PATH not set');
  console.log('   Fix: export GNOMAD_DB_PATH=/path/to/gnomad.genomes.v4.1.sites.db');
  allGood = false;
} else if (!existsSync(gnomadPath)) {
  console.log(`❌ GNOMAD_DB_PATH file not found: ${gnomadPath}`);
  allGood = false;
} else {
  console.log(`✅ GNOMAD_DB_PATH: ${gnomadPath}`);
}

// Check packs directory
const packsDir = path.join(dirname(__dirname), 'data_out', 'packs');
if (!existsSync(packsDir)) {
  console.log(`❌ Packs directory not found: ${packsDir}`);
  console.log('   Fix: Run ETL pipeline to generate parquet files');
  allGood = false;
} else {
  console.log(`✅ Packs directory: ${packsDir}`);
}

// Check dependencies
try {
  await import('better-sqlite3');
  console.log('✅ better-sqlite3 installed');
} catch (_e) {
  console.log('❌ better-sqlite3 not installed');
  console.log('   Fix: pnpm install');
  allGood = false;
}

try {
  await import('duckdb');
  console.log('✅ duckdb installed');
} catch (_e) {
  console.log('❌ duckdb not installed');
  console.log('   Fix: pnpm install');
  allGood = false;
}

// System info
console.log(`\n📊 System Info`);
console.log(`   CPUs: ${os.cpus().length}`);
console.log(`   Workers: ${Math.max(1, os.cpus().length - 1)}`);
console.log(`   RAM: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`);
console.log(`   Platform: ${os.platform()}`);

// Summary
console.log(`\n${'='.repeat(60)}`);
if (allGood) {
  console.log('✅ Environment ready for benchmarks!');
  console.log('\nRun: node scripts/run-benchmarks.js');
} else {
  console.log('❌ Environment not ready. Fix issues above first.');
  process.exit(1);
}
