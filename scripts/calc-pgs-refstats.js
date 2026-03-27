#!/usr/bin/env node
/**
 * Calculate PGS normalization statistics (mean/SD) for z-score normalization.
 *
 * Uses TOPMed reference panel allele frequencies for the theoretical distribution:
 *   E[PGS] = Σ(w_i × 2 × af_i)
 *   SD[PGS] = √Σ(w_i² × 2 × af_i × (1 - af_i))
 *
 * Requires: TOPMed panel (pnpm imputation setup) + built packs (pnpm etl local)
 *
 * For PGS with <50% AF coverage, falls back to af=0.5 assumption (less accurate
 * but better than using partial-coverage empirical stats).
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
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
const SCRIPT_PATH = path.join(__dirname, 'calc-pgs-refstats-topmed.py');
const OUTPUT_JSON = path.join(ROOT, 'data_out', 'pgs_topmed_stats.json');
const MANIFEST_DB = path.join(ROOT, 'data_out', 'trait_manifest.db');
const PACKS_DIR = path.join(ROOT, 'data_out', 'packs');

function _loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([^=:#]+)=(.*)$/);
    if (match) env[match[1].trim()] = match[2].trim();
  }
  return env;
}

const env = _loadEnv();
const PANEL_DIR = env.REF_PANEL_DIR || path.join(ROOT, 'cache', 'topmed_reference');

// Minimum AF coverage to trust empirical normalization.
// Below this, the mean/SD describe a different distribution than what gets scored.
const MIN_COVERAGE_PCT = 80;

function runCommand(cmd, args, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: 'inherit', shell: false });
    const handleSignal = signal => {
      console.log(`\n\n⚠️  Received ${signal}, killing child process...`);
      proc.kill('SIGKILL');
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

function dbQuery(conn, sql) {
  return new Promise((resolve, reject) => {
    conn.all(sql, (err, result) => (err ? reject(err) : resolve(result)));
  });
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

  const allPgs = await dbQuery(conn, 'SELECT pgs_id, norm_mean, norm_sd FROM pgs_scores');
  console.log(`Total PGS in manifest: ${allPgs.length}`);
  console.log(`TOPMed stats available: ${Object.keys(stats).length}\n`);

  let empirical = 0;
  let theoretical = 0;
  let skipped = 0;

  // Minimum coverage to use empirical stats at all.
  // Below this, the mean/SD are computed from so few variants they're meaningless.
  const MIN_USABLE_PCT = 5;

  for (const row of allPgs) {
    const data = stats[row.pgs_id];

    if (data && data.coverage_pct >= MIN_COVERAGE_PCT && data.stddev_score > 0) {
      // Good TOPMed coverage — use empirical stats
      await dbQuery(conn,
        `UPDATE pgs_scores SET norm_mean = ${data.mean_score}, norm_sd = ${data.stddev_score}, last_updated = CURRENT_TIMESTAMP WHERE pgs_id = '${row.pgs_id}'`
      );
      empirical++;
    } else if (data && data.coverage_pct >= MIN_USABLE_PCT && data.stddev_score > 0) {
      // Partial but usable coverage
      await dbQuery(conn,
        `UPDATE pgs_scores SET norm_mean = ${data.mean_score}, norm_sd = ${data.stddev_score}, last_updated = CURRENT_TIMESTAMP WHERE pgs_id = '${row.pgs_id}'`
      );
      theoretical++;
    } else {
      // Coverage too low or no data — leave NULL so the calculator uses
      // theoretical fallback from sum of squared weights at scoring time
      skipped++;
    }

    const total = empirical + theoretical + skipped;
    if (total % 100 === 0) process.stdout.write(`\r✓ ${total} processed`);
  }

  console.log(`\n\n✅ Updated ${allPgs.length} PGS scores in manifest`);
  console.log(`   ${empirical} with TOPMed AF (≥${MIN_COVERAGE_PCT}% coverage)`);
  console.log(`   ${theoretical} with partial TOPMed AF (${MIN_USABLE_PCT}-${MIN_COVERAGE_PCT}% coverage)`);
  console.log(`   ${skipped} with defaults (<${MIN_USABLE_PCT}% coverage or no data)`);

  conn.close();
  db.close();
}

async function resetStats() {
  console.log('🔄 Resetting all PGS normalization statistics...');
  const db = new duckdb.Database(MANIFEST_DB);
  const conn = db.connect();
  await dbQuery(conn, 'UPDATE pgs_scores SET norm_mean = NULL, norm_sd = NULL');
  console.log('✅ Reset complete\n');
  conn.close();
  db.close();
}

async function runBatch() {
  if (!existsSync(path.join(PANEL_DIR, 'chr1.topmed.vcf.gz'))) {
    console.log(`❌ TOPMed reference panel not found: ${PANEL_DIR}`);
    console.log('   Run: pnpm imputation setup');
    process.exit(1);
  }

  if (!existsSync(PACKS_DIR)) {
    console.log(`❌ Packs directory not found: ${PACKS_DIR}`);
    console.log('   Run: pnpm etl local');
    process.exit(1);
  }

  // Get list of all PGS that need processing
  const db = new duckdb.Database(MANIFEST_DB);
  const conn = db.connect();

  const allPgs = await dbQuery(conn,
    'SELECT DISTINCT pgs_id FROM pgs_scores'
  );
  const pgsToProcess = allPgs.map(r => r.pgs_id);

  conn.close();
  db.close();

  if (pgsToProcess.length === 0) {
    console.log('✅ No PGS scores in manifest.');
    return;
  }

  console.log(`Found ${pgsToProcess.length} PGS scores to normalize`);

  // Use cached results if available
  if (existsSync(OUTPUT_JSON)) {
    console.log('\n📄 Using existing TOPMed results file');
    console.log('   (Delete data_out/pgs_topmed_stats.json to regenerate)\n');
    await importToManifest();
    console.log('\n✅ Complete!');
    return;
  }

  const pgsListFile = path.join(ROOT, 'data_out', 'pgs_to_process.json');
  await writeFile(pgsListFile, JSON.stringify(pgsToProcess));

  await setupPython();

  console.log(`\n🧬 Computing normalization from TOPMed AF for ${pgsToProcess.length} PGS...`);
  console.log('   Press Ctrl+C to cancel\n');
  await runCommand(PYTHON_BIN, [
    SCRIPT_PATH,
    PANEL_DIR,
    PACKS_DIR,
    OUTPUT_JSON,
    pgsListFile
  ]);

  await importToManifest();
  console.log('\n✅ Complete!');
}

async function main() {
  const command = process.argv[2];
  try {
    if (command === 'reset') {
      await resetStats();
    } else {
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
