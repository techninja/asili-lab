#!/usr/bin/env node
/**
 * Calculate PGS normalization statistics (mean/SD) for z-score normalization.
 *
 * Scores 3,202 NYGC 30x 1000 Genomes individuals against all trait packs
 * and computes empirical mean/SD from the actual score distribution.
 *
 * Downloads NYGC 30x VCFs automatically if not present (~26GB).
 * All intermediate files are cached — safe to interrupt and resume.
 *
 * After scoring, automatically:
 *   - Exports norm params to pgs_norm_params.json
 *   - Regenerates histogram density arrays
 *
 * Usage:
 *   pnpm pgs refstats          — run all chromosomes (~6h first run)
 *   pnpm pgs refstats batch    — same
 *   pnpm pgs refstats --chr 22 — single chromosome (for testing, ~5min)
 *   pnpm pgs refstats reset    — clear extracted genotypes + manifest norms
 */
import '../packages/pipeline/lib/env.js';
import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
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
const SCRIPT_PATH = path.join(__dirname, 'calc-pgs-refstats-empirical.py');
const MANIFEST_DB = path.join(ROOT, 'data_out', 'trait_manifest.db');
const PACKS_DIR = path.join(ROOT, 'data_out', 'packs');

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

async function resetStats() {
  console.log('🔄 Resetting PGS normalization statistics...');

  if (existsSync(MANIFEST_DB)) {
    const db = new duckdb.Database(MANIFEST_DB);
    const conn = db.connect();
    await dbQuery(conn, 'UPDATE pgs_scores SET norm_mean = NULL, norm_sd = NULL');
    conn.close();
    db.close();
    console.log('  ✓ Cleared norm_mean/norm_sd in manifest');
  }

  await setupPython();
  await runCommand(PYTHON_BIN, [SCRIPT_PATH, '--reset']);
  console.log('✅ Reset complete\n');
}

async function postProcess() {
  console.log('\n📊 Post-processing: regenerating distributions...\n');
  execSync('node scripts/generate-score-distributions.js', {
    cwd: ROOT,
    stdio: 'inherit'
  });
}

async function runBatch(extraArgs = []) {
  if (!existsSync(PACKS_DIR)) {
    console.log(`❌ Packs directory not found: ${PACKS_DIR}`);
    console.log('   Run: pnpm etl local');
    process.exit(1);
  }

  await setupPython();

  console.log('\n🧬 Empirical PGS normalization (NYGC 30x × 1000 Genomes)');
  console.log('   Press Ctrl+C to cancel (will resume on next run)\n');
  await runCommand(PYTHON_BIN, [SCRIPT_PATH, ...extraArgs]);

  await postProcess();
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    if (command === 'reset') {
      await resetStats();
    } else {
      const passthrough = args.filter(a => a !== 'batch');
      await runBatch(passthrough);
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
