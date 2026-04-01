#!/usr/bin/env node

import { spawn } from 'child_process';
import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';
import '../packages/pipeline/lib/env.js';

const PIPELINE_DIR = './packages/pipeline';
const DATA_DIR = './data_out/imputation';

const COMMANDS = {
  setup: { fn: setupImputation, desc: 'Download Beagle, Eagle2, and TOPMed reference panel' },

  impute: { fn: imputeUser, desc: 'Run full imputation pipeline for user' },
  'verify-panel': {
    fn: verifyPanel,
    desc: 'Check reference panel and estimate coverage'
  },
  'optimize-panel': {
    fn: optimizePanel,
    desc: 'Convert reference panel to BCF for faster imputation'
  },
  status: { fn: showStatus, desc: 'Show system status' },
  clean: { fn: cleanData, desc: 'Clean imputation data' }
};

async function setupImputation() {
  console.log('\n📦 Setting up imputation system (Eagle2 + Beagle + TOPMed)...\n');

  await new Promise((resolve, reject) => {
    const proc = spawn('./scripts/setup-imputation.sh', [], { stdio: 'inherit' });
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`Exit code ${code}`))
    );
  });
}

async function optimizePanel() {
  console.log('\n⚡ Converting reference panel VCFs to BCF for faster I/O...\n');

  return new Promise((resolve, reject) => {
    const proc = spawn('./scripts/convert_panel_bcf.sh', [], { stdio: 'inherit' });
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`Exit code ${code}`))
    );
  });
}

async function verifyPanel() {
  console.log('\n🔍 Verifying reference panels...\n');

  return new Promise((resolve, reject) => {
    const proc = spawn('.venv/bin/python3', ['scripts/verify_panel.py'], {
      stdio: 'inherit'
    });
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`Exit code ${code}`))
    );
  });
}

async function imputeUser() {
  const variantsDir = './server-data/variants';

  try {
    await fs.access(variantsDir);
  } catch {
    console.log('\n❌ No variants directory found. Upload DNA files first.\n');
    return;
  }

  const files = await fs.readdir(variantsDir);
  const individuals = files
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const fullId = f.replace('.json', ''); // e.g., "1769791316003_Ethan"
      const [id, name] = fullId.split('_');
      return {
        file: f,
        id,
        name: name || 'Unknown',
        fullId,
        path: `${variantsDir}/${f}`
      };
    });

  if (individuals.length === 0) {
    console.log('\n❌ No individuals found. Upload DNA files first.\n');
    return;
  }

  const panelDir = process.env.REF_PANEL_DIR || './cache/topmed_reference';

  try {
    await fs.access(`${panelDir}/chr1.topmed.vcf.gz`);
  } catch {
    console.log(
      '\n❌ TOPMed reference panel not found. Run "pnpm imputation setup" first.\n'
    );
    return;
  }

  const { selected } = await prompts({
    type: 'select',
    name: 'selected',
    message: 'Select individual for imputation:',
    choices: individuals.map(ind => ({
      title: `${ind.name} (${ind.id})`,
      value: ind
    }))
  });

  if (!selected) return;

  console.log(`\n🧬 Running Eagle2 phasing + Beagle imputation for ${selected.name}`);
  console.log('📊 Panel: TOPMed (60-80% coverage)');
  console.log('⏱️  Estimated time: 1-2 hours\n');

  return new Promise((resolve, reject) => {
    const proc = spawn(
      '.venv/bin/python3',
      ['scripts/impute_user.py', selected.path, selected.fullId],
      {
        stdio: 'inherit',
        env: { ...process.env, REF_PANEL_DIR: panelDir }
      }
    );
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`Exit code ${code}`))
    );
  });
}

async function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(PIPELINE_DIR, script), ...args], {
      stdio: 'inherit'
    });
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`Exit code ${code}`))
    );
  });
}

async function showStatus() {
  console.log('\n📊 Imputation System Status\n');

  const checks = [
    {
      path: `${DATA_DIR}/manifests/user_specific.parquet`,
      label: 'User-specific manifest'
    },
    {
      path: `${DATA_DIR}/manifests/generic.parquet`,
      label: 'Generic manifest (fallback)'
    },
    {
      path: `${DATA_DIR}/panels/user_specific`,
      label: 'User-specific panels',
      isDir: true
    },
    {
      path: `${DATA_DIR}/panels/generic`,
      label: 'Generic panels',
      isDir: true
    },
    { path: `${DATA_DIR}/imputation.duckdb`, label: 'Unified database' }
  ];

  for (const check of checks) {
    try {
      const stat = await fs.stat(check.path);
      const size = check.isDir
        ? (
            await Promise.all(
              (await fs.readdir(check.path)).map(f =>
                fs.stat(path.join(check.path, f))
              )
            )
          ).reduce((sum, s) => sum + s.size, 0)
        : stat.size;
      console.log(
        `   ✅ ${check.label}: ${(size / 1024 / 1024).toFixed(1)} MB`
      );
    } catch {
      console.log(`   ❌ ${check.label}: Not found`);
    }
  }
  console.log();
}

async function cleanData() {
  const confirm = await prompts({
    type: 'confirm',
    name: 'value',
    message: 'Delete all imputation data?',
    initial: false
  });

  if (confirm.value) {
    await fs.rm(DATA_DIR, { recursive: true, force: true });
    console.log('✅ Cleaned\n');
  }
}

async function interactive() {
  console.clear();
  console.log('🧬 Asili Imputation System\n');

  const choices = Object.entries(COMMANDS).map(([key, cmd]) => ({
    title: `${key.padEnd(10)} - ${cmd.desc}`,
    value: key
  }));

  const { action } = await prompts({
    type: 'select',
    name: 'action',
    message: 'Select action:',
    choices: [...choices, { title: 'exit', value: 'exit' }]
  });

  if (!action || action === 'exit') return;

  const cmd = COMMANDS[action];
  console.log();

  if (cmd.fn) {
    await cmd.fn();
  } else {
    await run(cmd.script);
  }
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (!command) {
    await interactive();
  } else if (COMMANDS[command]) {
    const cmd = COMMANDS[command];
    if (cmd.fn) {
      await cmd.fn();
    } else {
      await run(cmd.script, args);
    }
  } else {
    console.log('Usage: pnpm imputation [command]\n');
    console.log('Commands:');
    Object.entries(COMMANDS).forEach(([key, cmd]) => {
      console.log(`  ${key.padEnd(10)} ${cmd.desc}`);
    });
    console.log('\nNo command = interactive mode');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
