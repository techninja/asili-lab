import chalk from 'chalk';
import './lib/env.js';
import prompts from 'prompts';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..');

const envPath = path.join(rootDir, '.env');
let NODE_MAX_OLD_SPACE_SIZE = '16384';
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  const match = envContent.match(/NODE_MAX_OLD_SPACE_SIZE=(\d+)/);
  if (match) NODE_MAX_OLD_SPACE_SIZE = match[1];
}

const nodeFlags = `--expose-gc --max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}`;

async function calcRefStats(pgsIdArg) {
  console.log(chalk.cyan('\n=== Empirical PGS Normalization (NYGC 30x × 1000 Genomes) ===\n'));

  if (pgsIdArg === 'reset') {
    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: 'Reset ALL PGS normalization statistics and extracted genotypes?',
      initial: false
    });
    if (!confirm) return;
    execSync(`node scripts/calc-pgs-refstats.js reset`, { cwd: rootDir, stdio: 'inherit' });
    return;
  }

  // Pass through any extra args (--chr N, batch, etc.)
  const extraArgs = process.argv.slice(3).join(' ');

  if (pgsIdArg === 'batch' || !pgsIdArg) {
    const { mode } = pgsIdArg ? { mode: 'batch' } : await prompts({
      type: 'select',
      name: 'mode',
      message: 'Select mode:',
      choices: [
        { title: 'Run empirical normalization (all chromosomes)', value: 'batch' },
        { title: 'Test single chromosome', value: 'chr' },
        { title: 'Reset all stats + extracted data', value: 'reset' }
      ]
    });
    if (!mode) return;

    if (mode === 'reset') {
      execSync(`node scripts/calc-pgs-refstats.js reset`, { cwd: rootDir, stdio: 'inherit' });
    } else if (mode === 'chr') {
      const { chr } = await prompts({
        type: 'number',
        name: 'chr',
        message: 'Chromosome (1-22):',
        initial: 22,
        validate: v => v >= 1 && v <= 22 || 'Must be 1-22'
      });
      if (!chr) return;
      execSync(`node scripts/calc-pgs-refstats.js --chr ${chr}`, { cwd: rootDir, stdio: 'inherit' });
    } else {
      execSync(`node scripts/calc-pgs-refstats.js batch ${extraArgs}`, { cwd: rootDir, stdio: 'inherit' });
    }
    return;
  }

  // Direct passthrough for any other args (e.g. --chr 22)
  execSync(`node scripts/calc-pgs-refstats.js ${pgsIdArg} ${extraArgs}`, { cwd: rootDir, stdio: 'inherit' });
}

async function checkPGS() {
  console.log(chalk.cyan('\n=== Check PGS Score ===\n'));

  const { pgsId } = await prompts({
    type: 'text',
    name: 'pgsId',
    message: 'Enter PGS ID to check (e.g., PGS000001):',
    validate: value => value.trim().length > 0 || 'PGS ID cannot be empty'
  });

  if (!pgsId) return;

  console.log(chalk.blue(`\nChecking ${pgsId}...\n`));
  execSync(`node scripts/check-pgs.js ${pgsId}`, {
    cwd: rootDir,
    stdio: 'inherit'
  });
}

async function analyzeProblematic() {
  console.log(chalk.cyan('\n=== Analyze Problematic PGS ===\n'));
  console.log(chalk.blue('Analyzing PGS scores with issues...\n'));
  execSync('node scripts/analyze-problematic-pgs.js', {
    cwd: rootDir,
    stdio: 'inherit'
  });
}

async function generateDistributions(binsArg) {
  console.log(chalk.cyan('\n=== Generate Score Distributions ===\n'));
  const bins = binsArg ? `--bins ${binsArg}` : '';
  execSync(`node scripts/generate-score-distributions.js ${bins}`, {
    cwd: rootDir,
    stdio: 'inherit'
  });
}

async function exportNormParams() {
  console.log(chalk.cyan('\n=== Export Norm Params ===\n'));
  execSync('node scripts/export-norm-params.js', {
    cwd: rootDir,
    stdio: 'inherit'
  });
}

async function generateAncestryNorms(afTsv) {
  console.log(chalk.cyan('\n=== Generate Ancestry-Specific Norms ===\n'));
  const packsDir = path.join(rootDir, 'data_out', 'packs');
  const normParams = path.join(rootDir, 'data_out', 'pgs_norm_params.json');
  const defaultTsv = path.join(rootDir, 'data_out', 'ancestry_af.tsv');

  // If no AF file provided, check for existing or offer to extract
  if (!afTsv) {
    if (existsSync(defaultTsv)) {
      afTsv = defaultTsv;
      console.log(chalk.blue(`Using existing AF file: ${defaultTsv}\n`));
    } else {
      console.log(chalk.yellow('No ancestry AF file found.'));
      console.log(chalk.blue('\nStep 1: Extract gnomAD v4 ancestry AFs (~300GB download, cached on LARGE_TMP):'));
      console.log(chalk.gray('   bash scripts/extract-gnomad-ancestry-af.sh\n'));
      console.log(chalk.gray('   Or one chromosome at a time:'));
      console.log(chalk.gray('   bash scripts/extract-gnomad-ancestry-af.sh 22\n'));
      console.log(chalk.blue('Step 2: Then run:'));
      console.log(chalk.gray('   pnpm pgs ancestry-norms\n'));
      return;
    }
  }

  const venvPython = path.join(rootDir, '.venv', 'bin', 'python3');
  const pythonBin = existsSync(venvPython) ? venvPython : 'python3';
  console.log(chalk.gray(`Using: ${pythonBin}`));
  console.log(chalk.gray(`Phases: filter AF → load → join packs`));
  console.log(chalk.gray(`Memory-safe: streams the big AF file, caches filtered version.\n`));
  execSync(`${pythonBin} scripts/generate-ancestry-norms.py "${afTsv}" "${packsDir}" "${normParams}"`, {
    cwd: rootDir,
    stdio: 'inherit',
    maxBuffer: 50 * 1024 * 1024
  });
}

async function viewScores() {
  console.log(chalk.cyan('\n=== View PGS Scores ===\n'));
  console.log(chalk.blue('Displaying PGS score information...\n'));
  execSync('node scripts/scores.js', { cwd: rootDir, stdio: 'inherit' });
}

async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];

  if (command === 'calc' || command === 'refstats') {
    await calcRefStats(arg);
    return;
  }

  if (command === 'check') {
    await checkPGS();
    return;
  }

  if (command === 'analyze') {
    await analyzeProblematic();
    return;
  }

  if (command === 'scores') {
    await viewScores();
    return;
  }

  if (command === 'score-distribution' || command === 'distributions') {
    await generateDistributions(arg);
    return;
  }

  if (command === 'export-norms' || command === 'export') {
    await exportNormParams();
    return;
  }

  if (command === 'ancestry-norms') {
    await generateAncestryNorms(arg);
    return;
  }

  console.log(chalk.bold.blue('\n🧬 Asili PGS Manager\n'));

  const { action } = await prompts({
    type: 'select',
    name: 'action',
    message: 'What would you like to do?',
    choices: [
      { title: '📊 Calculate reference statistics', value: 'calc' },
      { title: '🔍 Check PGS score', value: 'check' },
      { title: '⚠️  Analyze problematic PGS', value: 'analyze' },
      { title: '📋 View PGS scores', value: 'scores' },
      { title: '📊 Generate score distributions', value: 'distributions' },
      { title: '🌍 Generate ancestry norms', value: 'ancestry-norms' },
      { title: '🚪 Exit', value: 'exit' }
    ]
  });

  switch (action) {
    case 'calc':
      await calcRefStats();
      break;
    case 'check':
      await checkPGS();
      break;
    case 'analyze':
      await analyzeProblematic();
      break;
    case 'scores':
      await viewScores();
      break;
    case 'distributions':
      await generateDistributions();
      break;
    case 'ancestry-norms':
      await generateAncestryNorms();
      break;
    case 'exit':
      console.log(chalk.gray('Goodbye!'));
      return;
  }

  const { continue: shouldContinue } = await prompts({
    type: 'confirm',
    name: 'continue',
    message: 'Do something else?',
    initial: true
  });

  if (shouldContinue) {
    await main();
  }
}

main().catch(console.error);
