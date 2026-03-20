#!/usr/bin/env node

/**
 * Asili Test Runner
 *
 * Usage:
 *   pnpm test          — Interactive menu
 *   pnpm test all      — Run all tests
 *   pnpm test core     — Run core package tests
 *   pnpm test pipeline — Run pipeline tests
 *   pnpm test calc     — Run calc server tests
 *   pnpm test web      — Run web app tests
 */

import { execSync } from 'child_process';
import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Discover available test groups by checking for tests/ directories
const TEST_GROUPS = [];
const locations = [
  { dir: 'packages/core/tests', name: 'core', label: 'Core library (genomic processor, calculator, scorer)' },
  { dir: 'packages/pipeline/tests', name: 'pipeline', label: 'ETL pipeline' },
  { dir: 'apps/calc/tests', name: 'calc', label: 'Calculation server' },
  { dir: 'apps/web/tests', name: 'web', label: 'Web app' },
];

for (const loc of locations) {
  const fullPath = join(ROOT, loc.dir);
  if (existsSync(fullPath)) {
    try {
      const files = readdirSync(fullPath, { recursive: true });
      const testFiles = files.filter(f => f.toString().endsWith('.test.js'));
      if (testFiles.length > 0) {
        TEST_GROUPS.push({ ...loc, count: testFiles.length });
      }
    } catch { /* empty dir */ }
  }
}

function run(cmd) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    process.exit(e.status || 1);
  }
}

const arg = process.argv[2];

if (arg === 'all') {
  console.log('\n🧬 Running all Asili tests...\n');
  run('npx vitest run');
} else if (arg && arg !== '--help') {
  // Direct group run
  const group = TEST_GROUPS.find(g => g.name === arg);
  if (!group) {
    console.error(`\n❌ Unknown test group: "${arg}"`);
    console.error(`   Available: ${TEST_GROUPS.map(g => g.name).join(', ') || '(none found)'}`);
    console.error(`   Or use "all" to run everything\n`);
    process.exit(1);
  }
  console.log(`\n🧬 Running ${group.name} tests...\n`);
  run(`npx vitest run --project ${group.name}`);
} else if (arg === '--help') {
  printHelp();
} else {
  // Interactive menu
  await interactiveMenu();
}

function printHelp() {
  console.log(`
🧬 Asili Test Runner

Usage:
  pnpm test          Interactive menu
  pnpm test all      Run all tests
  pnpm test <group>  Run a specific group

Available groups:`);
  if (TEST_GROUPS.length === 0) {
    console.log('  (no test files found)');
  }
  for (const g of TEST_GROUPS) {
    console.log(`  ${g.name.padEnd(12)} ${g.label} (${g.count} files)`);
  }
  console.log();
}

async function interactiveMenu() {
  if (TEST_GROUPS.length === 0) {
    console.log('\n⚠️  No test files found. Create tests in packages/*/tests/ or apps/*/tests/\n');
    process.exit(0);
  }

  const prompts = (await import('prompts')).default;

  const choices = [
    { title: '🧪 All tests', value: 'all' },
    ...TEST_GROUPS.map(g => ({
      title: `${g.name.padEnd(10)} — ${g.label} (${g.count} files)`,
      value: g.name
    }))
  ];

  const { selection } = await prompts({
    type: 'select',
    name: 'selection',
    message: 'What would you like to test?',
    choices
  });

  if (!selection) {
    console.log('Cancelled.');
    process.exit(0);
  }

  if (selection === 'all') {
    console.log('\n🧬 Running all tests...\n');
    run('npx vitest run');
  } else {
    console.log(`\n🧬 Running ${selection} tests...\n`);
    run(`npx vitest run --project ${selection}`);
  }
}
