#!/usr/bin/env node

import { spawn } from 'child_process';
import prompts from 'prompts';
import fs from 'fs/promises';
import { mkdirSync, readdirSync } from 'fs';
import path from 'path';
import '../packages/pipeline/lib/env.js';
import { buildAsiliArchive, fileSizeMB } from '../packages/core/src/utils/asili-archive.js';
import { buildHg19Map } from './build-hg19map.js';

const PIPELINE_DIR = './packages/pipeline';
const DATA_DIR = './data_out/imputation';

const COMMANDS = {
  setup: {
    fn: setupImputation,
    desc: 'Download Beagle, Eagle2, and TOPMed reference panel'
  },

  impute: { fn: imputeUser, desc: 'Run full imputation pipeline for user' },
  'verify-panel': {
    fn: verifyPanel,
    desc: 'Check reference panel and estimate coverage'
  },
  'optimize-panel': {
    fn: optimizePanel,
    desc: 'Convert reference panel to BCF for faster imputation'
  },
  export: { fn: exportAsili, desc: 'Export unified parquet to .asili archive' },
  hg19map: { fn: buildHg19Map, desc: 'Build hg19→hg38 liftover .asili archive' },
  status: { fn: showStatus, desc: 'Show system status' },
  clean: { fn: cleanData, desc: 'Clean imputation data' }
};

async function setupImputation() {
  console.log(
    '\n📦 Setting up imputation system (Eagle2 + Beagle + TOPMed)...\n'
  );

  await new Promise((resolve, reject) => {
    const proc = spawn('./scripts/setup-imputation.sh', [], {
      stdio: 'inherit'
    });
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`Exit code ${code}`))
    );
  });
}

async function optimizePanel() {
  console.log(
    '\n⚡ Converting reference panel VCFs to BCF for faster I/O...\n'
  );

  return new Promise((resolve, reject) => {
    const proc = spawn('./scripts/convert_panel_bcf.sh', [], {
      stdio: 'inherit'
    });
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

  console.log(
    `\n🧬 Running Eagle2 phasing + Beagle imputation for ${selected.name}`
  );
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

async function exportAsili() {
  const __dir = path.dirname(new URL(import.meta.url).pathname);
  const UNIFIED_DIR = path.join(__dir, '../server-data/unified');
  const EXPORT_DIR = path.join(__dir, '../server-data/export');

  const parquetFiles = readdirSync(UNIFIED_DIR).filter(f => f.endsWith('.parquet'));
  if (parquetFiles.length === 0) {
    console.log('\n❌ No parquet files found in server-data/unified/\n');
    return;
  }

  // Check for CLI name filter: pnpm imputation export [name]
  const nameFilter = process.argv[3];
  let toExport;

  if (nameFilter) {
    toExport = parquetFiles.filter(f => f.toLowerCase().includes(nameFilter.toLowerCase()));
    if (toExport.length === 0) {
      console.log(`\n❌ No parquet files matching "${nameFilter}"\n`);
      return;
    }
  } else {
    const choices = parquetFiles.map(f => {
      const name = path.basename(f, '.parquet').split('_').slice(1).join('_');
      return { title: name, value: f };
    });
    choices.unshift({ title: 'All individuals', value: '__all__' });

    const { selected } = await prompts({
      type: 'select',
      name: 'selected',
      message: 'Export which individual?',
      choices
    });
    if (!selected) return;
    toExport = selected === '__all__' ? parquetFiles : [selected];
  }

  mkdirSync(EXPORT_DIR, { recursive: true });

  for (const parquetFile of toExport) {
    const name = path.basename(parquetFile, '.parquet').split('_').slice(1).join('_');
    const inputPath = path.join(UNIFIED_DIR, parquetFile);
    const outputFile = path.join(EXPORT_DIR, `${name}_imputed.asili`);

    console.log(`\n🧬 Exporting ${name}...`);

    const { totalVariants } = buildAsiliArchive({
      inputPath,
      outputPath: outputFile,
      format: 'asili-unified-v1',
      meta: {
        individual: name,
        source: 'AncestryDNA + TOPMed imputation'
      },
      statsQuery: `SELECT chr, COUNT(*) as variants, SUM(CASE WHEN imputed THEN 1 ELSE 0 END) as imputed_count, SUM(CASE WHEN NOT imputed THEN 1 ELSE 0 END) as genotyped_count FROM '${inputPath}' WHERE chr IS NOT NULL GROUP BY chr ORDER BY chr`
    });

    console.log(`  ✅ ${name}_imputed.asili (${fileSizeMB(outputFile)} MB — ${totalVariants.toLocaleString()} variants)`);
  }

  console.log('\n✓ Export complete\n');
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
