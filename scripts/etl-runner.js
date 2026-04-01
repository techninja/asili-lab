#!/usr/bin/env node

import { execSync } from 'child_process';
import prompts from 'prompts';
import chalk from 'chalk';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../packages/core/src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENV_PATH = path.join(__dirname, '..', '.venv');
const mode = process.argv[2];
const traitId = process.argv[3];

const logger = createLogger('etl-runner');

function checkPrerequisites() {
  const missing = [];

  try {
    const nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim();
    const major = parseInt(nodeVersion.slice(1).split('.')[0]);
    if (major < 18) missing.push(`Node.js >= 18 (found ${nodeVersion})`);
  } catch {
    missing.push('Node.js');
  }

  try {
    execSync('python3 --version', { stdio: 'pipe' });
  } catch {
    missing.push('Python 3');
  }

  try {
    execSync('duckdb --version', { stdio: 'pipe' });
  } catch {
    missing.push('DuckDB CLI');
  }

  return missing;
}

function setupVenv() {
  if (!existsSync(VENV_PATH)) {
    logger.log(chalk.blue('📦 Creating Python virtual environment...\n'));
    execSync('python3 -m venv .venv', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
  }

  logger.log(chalk.blue('📦 Installing Python dependencies...\n'));
  const pip = path.join(VENV_PATH, 'bin', 'pip');
  execSync(`${pip} install --quiet pandas pyarrow`, { stdio: 'inherit' });
  logger.log(chalk.green('✓ Python environment ready\n'));
}

async function runLocal() {
  logger.log(chalk.cyan('\n🔍 Checking prerequisites...\n'));

  const missing = checkPrerequisites();

  if (missing.length > 0) {
    logger.error(chalk.red('❌ Missing prerequisites:\n'));
    missing.forEach(dep => logger.log(chalk.yellow(`   - ${dep}`)));
    logger.log(chalk.blue('\n💡 Install with:\n'));
    logger.log(chalk.gray('   # macOS'));
    logger.log(chalk.gray('   brew install python3 duckdb\n'));
    logger.log(chalk.gray('   # Ubuntu/Debian'));
    logger.log(chalk.gray('   apt install python3 python3-venv'));
    logger.log(
      chalk.gray(
        '   wget https://github.com/duckdb/duckdb/releases/download/v1.4.3/duckdb_cli-linux-amd64.zip'
      )
    );
    logger.log(
      chalk.gray(
        '   unzip duckdb_cli-linux-amd64.zip && sudo mv duckdb /usr/local/bin/\n'
      )
    );
    logger.log(chalk.yellow('Or use Docker mode: pnpm etl docker\n'));
    logger.close();
    process.exit(1);
  }

  logger.log(chalk.green('✓ All prerequisites met\n'));

  setupVenv();

  logger.log(chalk.cyan('🧬 Running ETL locally with optimized settings...\n'));

  // Load .env file for performance settings
  const envPath = path.join(__dirname, '..', '.env');
  const envConfig = {};
  if (existsSync(envPath)) {
    const { readFileSync } = await import('fs');
    const envContent = readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        envConfig[match[1].trim()] = match[2].trim();
      }
    });
  }

  const env = {
    ...process.env,
    ...envConfig,
    PATH: `${path.join(VENV_PATH, 'bin')}:${process.env.PATH}`,
    OUTPUT_DIR: envConfig.OUTPUT_DIR || path.join(__dirname, '..', 'data_out')
  };

  // Display performance settings
  logger.log(chalk.blue('⚙️  Performance Configuration:'));
  logger.log(
    chalk.gray(`   Memory Limit: ${env.DUCKDB_MEMORY_LIMIT || '8GB (default)'}`)
  );
  logger.log(chalk.gray(`   Threads: ${env.DUCKDB_THREADS || 'auto'}`));
  logger.log(
    chalk.gray(
      `   Parallel Batches: ${env.MAX_PARALLEL_BATCHES || '2 (default)'}\n`
    )
  );

  if (traitId) {
    env.SINGLE_TRAIT = traitId;
    logger.log(chalk.blue(`   Processing single trait: ${traitId}\n`));
  }

  execSync('node etl_orchestrator.js', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..', 'packages', 'pipeline'),
    env
  });

  logger.close();
}

async function runDocker() {
  logger.log(chalk.cyan('\n🐳 Running ETL in Docker...\n'));

  if (traitId) {
    logger.log(chalk.blue(`   Processing single trait: ${traitId}\n`));
    execSync(
      `docker compose run --rm -e SINGLE_TRAIT=${traitId} pipeline node etl_orchestrator.js`,
      {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..')
      }
    );
  } else {
    execSync('docker compose run --rm pipeline node etl_orchestrator.js', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
  }

  logger.close();
}

async function main() {
  if (mode === 'local') {
    await runLocal();
    return;
  }

  if (mode === 'docker') {
    await runDocker();
    return;
  }

  logger.log(chalk.bold.blue('\n🧬 Asili ETL Pipeline\n'));

  const { choice } = await prompts({
    type: 'select',
    name: 'choice',
    message: 'How would you like to run the ETL?',
    choices: [
      {
        title: '💻 Local (uses local gnomAD, faster)',
        value: 'local',
        description: 'Run directly on your machine'
      },
      {
        title: '🐳 Docker (isolated, uses gnomAD if mounted)',
        value: 'docker',
        description: 'Run in Docker container'
      },
      {
        title: '🚪 Exit',
        value: 'exit'
      }
    ]
  });

  if (choice === 'local') {
    await runLocal();
  } else if (choice === 'docker') {
    await runDocker();
  } else {
    logger.log(chalk.gray('Goodbye!'));
    logger.close();
  }
}

main().catch(err => {
  logger.error(err);
  logger.close();
  process.exit(1);
});
