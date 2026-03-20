#!/usr/bin/env node

import { spawn } from 'child_process';
import prompts from 'prompts';
import fs from 'fs/promises';
import path from 'path';

const PIPELINE_DIR = './packages/pipeline';
const DATA_DIR = './data_out/imputation';

const COMMANDS = {
  'extract-positions': { fn: extractPGSPositions, desc: 'Extract unique positions from PGS traits' },
  'setup': { fn: setupBeagle, desc: 'Download Beagle and 1000G reference panel' },
  'setup-topmed': { fn: setupTOPMed, desc: 'Download TOPMed reference panel (150GB, 70% coverage)' },
  'impute': { fn: imputeUser, desc: 'Run full imputation pipeline for user' },
  'verify-panel': { fn: verifyPanel, desc: 'Check reference panel and estimate coverage' },
  status: { fn: showStatus, desc: 'Show system status' },
  clean: { fn: cleanData, desc: 'Clean imputation data' }
};

async function setupBeagle() {
  console.log('\n📦 Setting up Beagle imputation system...\n');
  
  // First, setup Beagle + 1000 Genomes
  await new Promise((resolve, reject) => {
    const proc = spawn('./scripts/setup-beagle.sh', [], { stdio: 'inherit' });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit code ${code}`)));
  });
  
  // Ask if user wants TOPMed
  console.log('\n📊 1000 Genomes setup complete (2.2% PGS coverage)\n');
  
  const { wantTopmed } = await prompts({
    type: 'confirm',
    name: 'wantTopmed',
    message: 'Download TOPMed panel for 60-80% coverage? (150GB, 2-6 hours)',
    initial: true
  });
  
  if (wantTopmed) {
    await setupTOPMed();
  } else {
    console.log('\n💡 You can download TOPMed later with: pnpm imputation setup-topmed\n');
  }
}

async function setupTOPMed() {
  console.log('\n🧬 Downloading TOPMed Reference Panel\n');
  console.log('⚠️  This will download ~150GB of data');
  console.log('⏱️  Estimated time: 2-6 hours depending on connection');
  console.log('📊 Expected PGS coverage: 60-80% (vs 2.2% with 1000G)\n');
  
  const { confirm } = await prompts({
    type: 'confirm',
    name: 'confirm',
    message: 'Continue with TOPMed download?',
    initial: false
  });
  
  if (!confirm) return;
  
  return new Promise((resolve, reject) => {
    const proc = spawn('./scripts/download_topmed_panel.sh', [], { stdio: 'inherit' });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit code ${code}`)));
  });
}

async function verifyPanel() {
  console.log('\n🔍 Verifying reference panels...\n');
  
  return new Promise((resolve, reject) => {
    const proc = spawn('.venv/bin/python3', ['scripts/verify_panel.py'], { stdio: 'inherit' });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit code ${code}`)));
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
      return { file: f, id, name: name || 'Unknown', fullId, path: `${variantsDir}/${f}` };
    });
  
  if (individuals.length === 0) {
    console.log('\n❌ No individuals found. Upload DNA files first.\n');
    return;
  }
  
  // Check available reference panels
  const panels = [];
  try {
    await fs.access('./cache/topmed_reference/chr1.topmed.vcf.gz');
    panels.push({ name: 'TOPMed', path: './cache/topmed_reference', coverage: '60-80%', time: '2-3 hours' });
  } catch {}
  
  try {
    await fs.access('./cache/1000g_reference/chr1.1kg.phase3.v5a.vcf.gz');
    panels.push({ name: '1000 Genomes', path: './cache/1000g_reference', coverage: '2.2%', time: '45-60 min' });
  } catch {}
  
  if (panels.length === 0) {
    console.log('\n❌ No reference panel found. Run "pnpm imputation setup" first.\n');
    return;
  }
  
  let selectedPanel = panels[0]; // Default to first (TOPMed if available)
  
  if (panels.length > 1) {
    const { panel } = await prompts({
      type: 'select',
      name: 'panel',
      message: 'Select reference panel:',
      choices: panels.map(p => ({
        title: `${p.name} (${p.coverage} coverage, ~${p.time})`,
        value: p
      }))
    });
    if (!panel) return;
    selectedPanel = panel;
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
  
  console.log(`\n🧬 Running Beagle imputation for ${selected.name}`);
  console.log(`📊 Panel: ${selectedPanel.name} (${selectedPanel.coverage} coverage)`);
  console.log(`⏱️  Estimated time: ${selectedPanel.time}\n`);
  
  return new Promise((resolve, reject) => {
    const proc = spawn('.venv/bin/python3', [
      'scripts/impute_user.py',
      selected.path,
      selected.fullId
    ], { 
      stdio: 'inherit',
      env: { ...process.env, REF_PANEL_DIR: selectedPanel.path }
    });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit code ${code}`)));
  });
}

async function extractPGSPositions() {
  console.log('\n📍 Extracting unique positions from PGS trait files...\n');
  
  return new Promise((resolve, reject) => {
    const proc = spawn('.venv/bin/python3', ['scripts/extract_pgs_positions.py'], { stdio: 'inherit' });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit code ${code}`)));
  });
}

async function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(PIPELINE_DIR, script), ...args], { stdio: 'inherit' });
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit code ${code}`)));
  });
}

async function showStatus() {
  console.log('\n📊 Imputation System Status\n');
  
  const checks = [
    { path: `${DATA_DIR}/manifests/user_specific.parquet`, label: 'User-specific manifest' },
    { path: `${DATA_DIR}/manifests/generic.parquet`, label: 'Generic manifest (fallback)' },
    { path: `${DATA_DIR}/panels/user_specific`, label: 'User-specific panels', isDir: true },
    { path: `${DATA_DIR}/panels/generic`, label: 'Generic panels', isDir: true },
    { path: `${DATA_DIR}/imputation.duckdb`, label: 'Unified database' }
  ];

  for (const check of checks) {
    try {
      const stat = await fs.stat(check.path);
      const size = check.isDir 
        ? (await Promise.all((await fs.readdir(check.path)).map(f => fs.stat(path.join(check.path, f))))).reduce((sum, s) => sum + s.size, 0)
        : stat.size;
      console.log(`   ✅ ${check.label}: ${(size / 1024 / 1024).toFixed(1)} MB`);
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
  const [,, command, ...args] = process.argv;

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
