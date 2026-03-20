#!/usr/bin/env node
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import duckdb from 'duckdb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const VENV_PATH = path.join(ROOT, '.venv');
const PYTHON_BIN = path.join(VENV_PATH, 'bin', 'python3');
const PIP_BIN = path.join(VENV_PATH, 'bin', 'pip');
const REQUIREMENTS = path.join(ROOT, 'requirements.txt');
const SCRIPT_PATH = path.join(__dirname, 'calc-pgs-refstats.py');
const OUTPUT_JSON = path.join(ROOT, 'data_out', 'pgs_gnomad_stats.json');
const MANIFEST_DB = path.join(ROOT, 'data_out', 'trait_manifest.db');
const GNOMAD_PARQUET = '/home/techninja/web/gnomad.genomes.v4.1.sites.parquet';
const PACKS_DIR = path.join(ROOT, 'data_out', 'packs');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return {};
  
  const env = {};
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const match = line.match(/^([^=:#]+)=(.*)$/);
    if (match) env[match[1].trim()] = match[2].trim();
  }
  return env;
}

function runCommand(cmd, args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: 'inherit', shell: false });
    
    // Handle Ctrl+C gracefully - kill child process
    const handleSignal = (signal) => {
      console.log(`\n\n⚠️  Received ${signal}, killing child process...`);
      proc.kill('SIGKILL'); // Force kill Python process
      setTimeout(() => process.exit(130), 500);
    };
    
    process.on('SIGINT', () => handleSignal('SIGINT'));
    process.on('SIGTERM', () => handleSignal('SIGTERM'));
    
    proc.on('close', code => {
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
      if (code === 0) resolve();
      else reject(new Error(`Exit ${code}`));
    });
  });
}

async function setupPython() {
  if (!existsSync(PYTHON_BIN)) {
    console.log('Creating Python venv...');
    await runCommand('python3', ['-m', 'venv', VENV_PATH]);
  }
  
  console.log('Installing Python dependencies...');
  await runCommand(PIP_BIN, ['install', '-q', '-r', REQUIREMENTS]);
}

async function importToManifest() {
  console.log('\n📥 Importing results to manifest...\n');
  
  if (!existsSync(OUTPUT_JSON)) {
    console.log('❌ No results file found. Run batch mode first.');
    process.exit(1);
  }
  
  const stats = JSON.parse(await readFile(OUTPUT_JSON, 'utf8'));
  const db = new duckdb.Database(MANIFEST_DB);
  const conn = db.connect();
  
  const query = (sql) => new Promise((resolve, reject) => {
    conn.all(sql, (err, result) => err ? reject(err) : resolve(result));
  });
  
  // Get all PGS that don't have normalization data yet
  const missingStats = await query(`SELECT pgs_id FROM pgs_scores WHERE norm_mean IS NULL OR norm_sd IS NULL`);
  const missingPgsIds = new Set(missingStats.map(row => row.pgs_id));
  
  console.log(`Found ${missingPgsIds.size} PGS without normalization data`);
  console.log(`Processing ${Object.keys(stats).length} PGS from gnomAD results\n`);
  
  let updated = 0;
  let empirical = 0;
  let theoretical = 0;
  let skipped = 0;
  
  // First, update PGS that have gnomAD data with sufficient coverage
  const MIN_COVERAGE_PCT = 1; // Require 1% coverage for empirical normalization
  
  for (const [pgs_id, data] of Object.entries(stats)) {
    if (!missingPgsIds.has(pgs_id)) {
      skipped++;
      continue; // Already has data
    }
    
    // Only use empirical data if coverage is sufficient
    if (data.mean_score !== null && data.stddev_score !== null && data.coverage_pct >= MIN_COVERAGE_PCT) {
      // Empirical data from gnomAD with good coverage
      const meanVal = data.mean_score !== null ? data.mean_score : 'NULL';
      const sdVal = data.stddev_score !== null ? data.stddev_score : 'NULL';
      await query(`UPDATE pgs_scores SET norm_mean = ${meanVal}, norm_sd = ${sdVal}, last_updated = CURRENT_TIMESTAMP WHERE pgs_id = '${pgs_id}'`);
      empirical++;
      updated++;
    }
    if (updated % 100 === 0) process.stdout.write(`\r✓ ${updated} processed (${empirical} empirical)`);
  }
  
  // Now add theoretical defaults for remaining PGS without data
  const stillMissing = await query(`SELECT pgs_id FROM pgs_scores WHERE norm_mean IS NULL OR norm_sd IS NULL`);
  
  if (stillMissing.length > 0) {
    console.log(`\n\n📊 Adding theoretical defaults for ${stillMissing.length} PGS without gnomAD data...`);
    
    for (const row of stillMissing) {
      await query(`UPDATE pgs_scores SET norm_mean = 0, norm_sd = 1.0, last_updated = CURRENT_TIMESTAMP WHERE pgs_id = '${row.pgs_id}'`);
      theoretical++;
      if (theoretical % 100 === 0) process.stdout.write(`\r✓ ${theoretical}/${stillMissing.length}`);
    }
  }
  
  console.log(`\n\n✅ Updated ${updated + theoretical} PGS scores in manifest`);
  console.log(`   ${empirical} with empirical data from gnomAD`);
  console.log(`   ${theoretical} with theoretical defaults (mean=0, sd=1.0)`);
  console.log(`   ${skipped} skipped (already had data)`);
  
  conn.close();
  db.close();
}

async function resetStats() {
  console.log('🔄 Resetting all PGS normalization statistics...');
  
  const db = new duckdb.Database(MANIFEST_DB);
  const conn = db.connect();
  
  const query = (sql) => new Promise((resolve, reject) => {
    conn.all(sql, (err, result) => err ? reject(err) : resolve(result));
  });
  
  await query('UPDATE pgs_scores SET norm_mean = NULL, norm_sd = NULL');
  console.log('✅ Reset complete\n');
  
  conn.close();
  db.close();
}

async function runBatch() {
  if (!existsSync(GNOMAD_PARQUET)) {
    console.log(`❌ gnomAD parquet not found: ${GNOMAD_PARQUET}`);
    console.log('   Convert SQLite to parquet first (see scripts/PYARROW_REFSTATS.md)');
    process.exit(1);
  }
  
  if (!existsSync(PACKS_DIR)) {
    console.log(`❌ Packs directory not found: ${PACKS_DIR}`);
    console.log('   Run: pnpm etl');
    process.exit(1);
  }
  
  // Check if we need to run gnomAD processing
  const db = new duckdb.Database(MANIFEST_DB);
  const conn = db.connect();
  const query = (sql) => new Promise((resolve, reject) => {
    conn.all(sql, (err, result) => err ? reject(err) : resolve(result));
  });
  
  const missingStats = await query(`SELECT COUNT(*) as count FROM pgs_scores WHERE norm_mean IS NULL OR norm_sd IS NULL`);
  const missingCount = missingStats[0].count;
  
  conn.close();
  db.close();
  
  if (missingCount === 0) {
    console.log('✅ All PGS already have normalization data. Nothing to do.');
    return;
  }
  
  console.log(`Found ${missingCount} PGS without normalization data`);
  
  // If we have existing results, just use them to fill in missing data
  if (existsSync(OUTPUT_JSON)) {
    console.log('\n📄 Using existing gnomAD results file');
    console.log('   (Delete data_out/pgs_gnomad_stats.json to regenerate)\n');
    await importToManifest();
    console.log('\n✅ Complete!');
    return;
  }
  
  // Get list of PGS that need processing and write to file
  const db2 = new duckdb.Database(MANIFEST_DB);
  const conn2 = db2.connect();
  const query2 = (sql) => new Promise((resolve, reject) => {
    conn2.all(sql, (err, result) => err ? reject(err) : resolve(result));
  });
  
  const missingPgs = await query2(`
    SELECT DISTINCT ps.pgs_id, tp.trait_id 
    FROM pgs_scores ps
    JOIN trait_pgs tp ON ps.pgs_id = tp.pgs_id
    WHERE ps.norm_mean IS NULL OR ps.norm_sd IS NULL
  `);
  
  const pgsToProcess = missingPgs.map(row => row.pgs_id);
  const packsNeeded = [...new Set(missingPgs.map(row => row.trait_id))];
  
  console.log(`   Requires ${packsNeeded.length} trait packs\n`);
  
  conn2.close();
  db2.close();
  
  const { writeFile } = await import('fs/promises');
  const pgsListFile = path.join(ROOT, 'data_out', 'pgs_to_process.json');
  const packsFile = path.join(ROOT, 'data_out', 'packs_to_process.json');
  await writeFile(pgsListFile, JSON.stringify(pgsToProcess));
  await writeFile(packsFile, JSON.stringify(packsNeeded));
  
  await setupPython();
  
  console.log(`\n🧬 Running PyArrow refstats calculator for ${missingCount} PGS...`);
  console.log('   Press Ctrl+C to cancel\n');
  await runCommand(PYTHON_BIN, [SCRIPT_PATH, GNOMAD_PARQUET, PACKS_DIR, OUTPUT_JSON, pgsListFile, packsFile]);
  
  await importToManifest();
  console.log('\n✅ Complete!');
}

async function runSingle(pgsId) {
  console.log(`\n⚠️  Single PGS mode not yet implemented for PyArrow version`);
  console.log(`   Use batch mode to calculate all PGS, or use benchmark script:`);
  console.log(`   .venv/bin/python3 scripts/benchmark-pgs.py ${GNOMAD_PARQUET} <pack_file> ${pgsId}\n`);
  process.exit(1);
}

async function main() {
  const command = process.argv[2];
  
  try {
    if (command === 'reset') {
      await resetStats();
    } else if (command && command !== 'batch') {
      // Single PGS ID provided
      await runSingle(command);
    } else {
      // Batch mode (default)
      await runBatch();
    }
  } catch (err) {
    if (err.message.includes('Exit 130')) {
      console.log('\n\n⚠️  Interrupted by user');
      process.exit(130);
    }
    throw err;
  }
}

main().catch(console.error);
