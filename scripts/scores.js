#!/usr/bin/env node

/**
 * Asili Score Analysis & Validation
 *
 * Usage:
 *   pnpm scores              — Interactive menu
 *   pnpm scores summary      — Overall stats
 *   pnpm scores extremes     — Analyze extreme z-scores
 *   pnpm scores coverage     — Low coverage PGS
 *   pnpm scores audit        — PGS selection audit (all traits)
 *   pnpm scores audit EFO_0004340  — Audit specific trait
 *   pnpm scores audit --flags      — Only flagged traits
 *   pnpm scores validate     — Quick pass/fail validation
 */

import { execSync } from 'child_process';
import chalk from 'chalk';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data_out/risk_scores.db');
const MANIFEST_PATH = path.join(__dirname, '../data_out/trait_manifest.db');

// ── Shared helpers ──────────────────────────────────────────────────────────

function qr(sql) {
  try {
    const result = execSync(`duckdb "${DB_PATH}" -json -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8', maxBuffer: 50 * 1024 * 1024
    });
    return result.trim() ? JSON.parse(result) : [];
  } catch (e) {
    console.error(chalk.red(`Query failed: ${e.message}`));
    return [];
  }
}

function qm(sql) {
  try {
    const result = execSync(`duckdb "${MANIFEST_PATH}" -json -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8', maxBuffer: 50 * 1024 * 1024
    });
    return result.trim() ? JSON.parse(result) : [];
  } catch (e) {
    console.error(chalk.red(`Manifest query failed: ${e.message}`));
    return [];
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

function summary() {
  console.log(chalk.cyan('\n=== Overall Summary ===\n'));

  const stats = qr(`
    SELECT
      COUNT(DISTINCT individual_id) as individuals,
      COUNT(DISTINCT trait_id) as traits,
      COUNT(*) as total_calculations,
      SUM(CASE WHEN ABS(z_score) > 10 THEN 1 ELSE 0 END) as extreme_z,
      SUM(CASE WHEN ABS(z_score) > 5 THEN 1 ELSE 0 END) as high_z,
      SUM(CASE WHEN matched_variants::FLOAT / NULLIF(expected_variants, 0) < 0.05 THEN 1 ELSE 0 END) as low_coverage
    FROM pgs_results
    WHERE z_score IS NOT NULL
  `)[0];

  if (!stats) { console.log(chalk.red('No data found')); return stats; }

  const pct = (n) => (n / stats.total_calculations * 100).toFixed(2);

  console.log(`Individuals: ${stats.individuals}`);
  console.log(`Traits: ${stats.traits}`);
  console.log(`Total PGS calculations: ${stats.total_calculations.toLocaleString()}`);
  console.log(chalk.red(`\nExtreme z-scores (>10σ): ${stats.extreme_z} (${pct(stats.extreme_z)}%)`));
  console.log(chalk.yellow(`High z-scores (>5σ): ${stats.high_z} (${pct(stats.high_z)}%)`));
  console.log(chalk.yellow(`Low coverage (<5%): ${stats.low_coverage} (${pct(stats.low_coverage)}%)`));

  return stats;
}

// ── Extreme Z-Scores ────────────────────────────────────────────────────────

function extremes() {
  console.log(chalk.cyan('\n=== Extreme Z-Scores (|z| > 10σ) ===\n'));

  const rows = qr(`
    SELECT pgs_id, individual_id, raw_score, z_score, matched_variants, expected_variants,
           ROUND(matched_variants::FLOAT / NULLIF(expected_variants, 0) * 100, 1) as coverage_pct
    FROM pgs_results
    WHERE ABS(z_score) > 10
    ORDER BY ABS(z_score) DESC
    LIMIT 50
  `);

  console.log(chalk.red(`Found ${rows.length} PGS with |z-score| > 10σ\n`));

  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.pgs_id]) grouped[row.pgs_id] = [];
    grouped[row.pgs_id].push(row);
  }

  for (const [pgsId, pgsRows] of Object.entries(grouped)) {
    const info = qm(`
      SELECT norm_mean, norm_sd, variants_number, weight_type, method_name
      FROM pgs_scores WHERE pgs_id = '${pgsId}'
    `)[0];

    console.log(chalk.yellow(`\n${pgsId} (${pgsRows.length} individuals affected)`));
    if (info) {
      console.log(`  Normalization: mean=${info.norm_mean?.toFixed(4)}, SD=${info.norm_sd?.toFixed(4)}`);
      console.log(`  Total variants: ${info.variants_number?.toLocaleString()}`);
      console.log(`  Type: ${info.weight_type} | Method: ${info.method_name}`);
    }
    for (const r of pgsRows.slice(0, 3)) {
      console.log(chalk.red(`    ${r.individual_id}: z=${r.z_score.toFixed(1)}σ, raw=${r.raw_score.toFixed(4)}, coverage=${r.coverage_pct}%`));
    }
    if (pgsRows.length > 3) console.log(chalk.gray(`    ... and ${pgsRows.length - 3} more`));
  }
}

// ── Low Coverage ────────────────────────────────────────────────────────────

function coverage() {
  console.log(chalk.cyan('\n=== Low Coverage PGS (<5%) ===\n'));

  const rows = qr(`
    SELECT pgs_id, COUNT(*) as affected,
           AVG(matched_variants::FLOAT / NULLIF(expected_variants, 0) * 100) as avg_cov,
           MAX(ABS(z_score)) as max_z
    FROM pgs_results
    WHERE matched_variants::FLOAT / NULLIF(expected_variants, 0) < 0.05
    GROUP BY pgs_id ORDER BY max_z DESC LIMIT 20
  `);

  console.log(chalk.yellow(`Found ${rows.length} PGS with <5% coverage\n`));

  for (const r of rows) {
    const info = qm(`SELECT norm_sd, variants_number FROM pgs_scores WHERE pgs_id = '${r.pgs_id}'`)[0];
    console.log(chalk.yellow(`${r.pgs_id}:`));
    console.log(`  Avg coverage: ${r.avg_cov.toFixed(1)}% | Max |z|: ${r.max_z.toFixed(1)}σ | Affected: ${r.affected}`);
    if (info) console.log(`  SD: ${info.norm_sd?.toFixed(6)} (${info.variants_number?.toLocaleString()} variants)`);
  }
}

// ── Small SDs ───────────────────────────────────────────────────────────────

function smallSDs() {
  console.log(chalk.cyan('\n=== Suspiciously Small SDs ===\n'));

  const rows = qm(`
    SELECT pgs_id, norm_mean, norm_sd, variants_number, weight_type, method_name
    FROM pgs_scores WHERE norm_sd < 0.1 AND norm_sd > 0
    ORDER BY norm_sd ASC LIMIT 20
  `);

  console.log(chalk.yellow(`Found ${rows.length} PGS with SD < 0.1\n`));

  for (const pgs of rows) {
    const usage = qr(`SELECT COUNT(*) as count, MAX(ABS(z_score)) as max_z FROM pgs_results WHERE pgs_id = '${pgs.pgs_id}'`)[0];
    console.log(chalk.yellow(`${pgs.pgs_id}:`));
    console.log(`  SD: ${pgs.norm_sd.toFixed(6)} (mean: ${pgs.norm_mean.toFixed(6)}) | Variants: ${pgs.variants_number?.toLocaleString()}`);
    console.log(`  Type: ${pgs.weight_type} | Method: ${pgs.method_name}`);
    if (usage) console.log(`  Used in ${usage.count} calculations, max |z|: ${usage.max_z?.toFixed(1)}σ`);
  }
}

// ── PGS Selection Audit ─────────────────────────────────────────────────────

function audit(filterTrait, flagsOnly) {
  // Load trait names
  const traitNames = new Map();
  for (const t of qm(`SELECT trait_id, editorial_name, name, emoji, trait_type, unit FROM traits`)) {
    traitNames.set(t.trait_id, { name: t.editorial_name || t.name, emoji: t.emoji || '', type: t.trait_type, unit: t.unit });
  }

  // Load R² data
  const r2Map = new Map();
  for (const p of qm(`SELECT pgs_id, metric_value FROM pgs_performance WHERE metric_type IN ('R²', 'PGS R2 (no covariates)')`)) {
    const val = p.metric_value > 1 ? p.metric_value / 100 : p.metric_value;
    if (val > (r2Map.get(p.pgs_id) || 0)) r2Map.set(p.pgs_id, val);
  }

  const traitResults = qr(`
    SELECT individual_id, trait_id, best_pgs_id, overall_z_score, overall_percentile, value
    FROM trait_results ${filterTrait ? `WHERE trait_id = '${filterTrait}'` : ''}
    ORDER BY trait_id, individual_id
  `);

  let totalTraits = 0, flaggedTraits = 0;
  const allFlags = [];

  for (const tr of traitResults) {
    const trait = traitNames.get(tr.trait_id) || { name: tr.trait_id, emoji: '', type: 'disease_risk' };

    const allPgs = qr(`
      SELECT pgs_id, quality_score, raw_score, z_score, percentile,
             matched_variants, expected_variants, genotyped_variants, imputed_variants,
             performance_metric, insufficient_data,
             ROUND(matched_variants::FLOAT / NULLIF(expected_variants, 0) * 100, 1) as coverage_pct,
             CASE WHEN matched_variants > 0
               THEN ROUND(genotyped_variants::FLOAT / matched_variants * 100, 1) ELSE 0 END as genotyped_pct
      FROM pgs_results
      WHERE individual_id = '${tr.individual_id}' AND trait_id = '${tr.trait_id}'
      ORDER BY quality_score DESC
    `);

    if (allPgs.length === 0) continue;
    totalTraits++;

    const best = allPgs[0];
    const runnerUp = allPgs[1];
    const bestR2 = r2Map.get(best.pgs_id) || best.performance_metric || 0.05;
    const traitFlags = [];

    // Flag: best uses default R² but alternatives have real R²
    if (bestR2 <= 0.05 && allPgs.some(p => (r2Map.get(p.pgs_id) || 0) > 0.05))
      traitFlags.push('🔴 Best PGS uses default R² (0.05) but alternatives have real R²');

    // Flag: runner-up has much higher R²
    if (runnerUp) {
      const runnerR2 = r2Map.get(runnerUp.pgs_id) || runnerUp.performance_metric || 0.05;
      if (runnerR2 > bestR2 * 2 && runnerR2 > 0.05)
        traitFlags.push(`🟡 Runner-up ${runnerUp.pgs_id} has ${(runnerR2*100).toFixed(1)}% R² vs best's ${(bestR2*100).toFixed(1)}%`);
    }

    if (best.coverage_pct < 5)
      traitFlags.push(`🔴 Best PGS has only ${best.coverage_pct}% coverage`);
    if (best.genotyped_pct === 0 && best.matched_variants > 0)
      traitFlags.push('🟡 Best PGS is 100% imputed (0% genotyped)');
    if (best.z_score !== null && Math.abs(best.z_score) > 5)
      traitFlags.push(`🔴 Extreme z-score: ${best.z_score.toFixed(1)}σ`);
    if (runnerUp && best.quality_score - runnerUp.quality_score < 2)
      traitFlags.push(`🟡 Tight race: best=${best.quality_score.toFixed(1)} vs runner-up=${runnerUp.quality_score.toFixed(1)} (Δ${(best.quality_score - runnerUp.quality_score).toFixed(1)})`);
    if (best.insufficient_data)
      traitFlags.push('🔴 Best PGS marked as insufficient data');

    if (traitFlags.length > 0) flaggedTraits++;
    if (flagsOnly && traitFlags.length === 0) continue;

    // Print trait header
    const valueStr = tr.value != null && trait.type === 'quantitative' ? ` → ${tr.value.toFixed(1)} ${trait.unit || ''}` : '';
    const zStr = tr.overall_z_score != null ? `z=${tr.overall_z_score.toFixed(2)}σ` : 'z=N/A';

    console.log(chalk.cyan(`\n${'─'.repeat(80)}`));
    console.log(chalk.bold(`${trait.emoji} ${trait.name} (${tr.trait_id}) — ${tr.individual_id}`));
    console.log(chalk.gray(`  Result: ${zStr}, P${tr.overall_percentile?.toFixed(0) || '?'}${valueStr}`));
    console.log(chalk.gray(`  PGS count: ${allPgs.length}`));

    if (traitFlags.length > 0) {
      console.log(chalk.red(`  FLAGS:`));
      for (const f of traitFlags) console.log(chalk.red(`    ${f}`));
      allFlags.push({ trait: `${trait.emoji} ${trait.name}`, individual: tr.individual_id, flags: traitFlags });
    }

    // PGS comparison table
    console.log('');
    console.log(chalk.gray('  Rank  PGS ID       QS     R²      Coverage   Genotyped  Z-score  Matched'));
    console.log(chalk.gray('  ' + '─'.repeat(76)));

    for (let i = 0; i < Math.min(allPgs.length, 5); i++) {
      const p = allPgs[i];
      const r2 = r2Map.get(p.pgs_id) || p.performance_metric || 0.05;
      const isChosen = p.pgs_id === tr.best_pgs_id;
      const marker = isChosen ? chalk.green('★') : ' ';
      const line = `  ${marker} #${i+1}  ${p.pgs_id.padEnd(12)} ${(p.quality_score?.toFixed(1) || '?').padStart(5)}  ${(r2*100).toFixed(1).padStart(5)}%  ${(p.coverage_pct+'%').padStart(8)}  ${(p.genotyped_pct+'%').padStart(8)}   ${p.z_score != null ? p.z_score.toFixed(2).padStart(7) : '   N/A'}  ${p.matched_variants?.toLocaleString().padStart(10)}`;

      console.log(isChosen ? chalk.green(line) : i === 1 ? chalk.yellow(line) : chalk.gray(line));
    }

    if (allPgs.length > 5) {
      const worst = allPgs[allPgs.length - 1];
      const r2w = r2Map.get(worst.pgs_id) || worst.performance_metric || 0.05;
      console.log(chalk.gray(`  ... ${allPgs.length - 5} more ...`));
      console.log(chalk.gray(`   #${allPgs.length}  ${worst.pgs_id.padEnd(12)} ${(worst.quality_score?.toFixed(1) || '?').padStart(5)}  ${(r2w*100).toFixed(1).padStart(5)}%  ${(worst.coverage_pct+'%').padStart(8)}  ${(worst.genotyped_pct+'%').padStart(8)}   ${worst.z_score != null ? worst.z_score.toFixed(2).padStart(7) : '   N/A'}  ${worst.matched_variants?.toLocaleString().padStart(10)}`));
    }
  }

  // Audit summary
  console.log(chalk.cyan(`\n${'═'.repeat(80)}`));
  console.log(chalk.bold(`\nAudit Summary`));
  console.log(`  Total trait calculations: ${totalTraits}`);
  console.log(`  Flagged: ${chalk.red(flaggedTraits)} (${(flaggedTraits/totalTraits*100).toFixed(1)}%)`);
  console.log(`  Clean: ${chalk.green(totalTraits - flaggedTraits)}`);

  if (allFlags.length > 0) {
    console.log(chalk.red(`\n  All Flags:`));
    for (const f of allFlags) {
      console.log(chalk.yellow(`    ${f.trait} (${f.individual}):`));
      for (const fl of f.flags) console.log(`      ${fl}`);
    }
  }
  console.log('');

  return { totalTraits, flaggedTraits };
}

// ── Validate (quick pass/fail) ──────────────────────────────────────────────

function validate() {
  console.log(chalk.cyan('\n=== Score Validation ===\n'));

  const checks = [];

  // Check 1: All individuals have results
  const indStats = qr(`
    SELECT individual_id, COUNT(DISTINCT trait_id) as traits
    FROM trait_results GROUP BY individual_id
  `);
  const totalTraits = qr(`SELECT COUNT(DISTINCT trait_id) as n FROM trait_results`)[0]?.n || 0;
  for (const ind of indStats) {
    const pass = ind.traits === totalTraits;
    checks.push({ name: `${ind.individual_id} has all traits`, pass, detail: `${ind.traits}/${totalTraits}` });
  }

  // Check 2: Extreme z-score rate
  const stats = qr(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN ABS(z_score) > 10 THEN 1 ELSE 0 END) as extreme
    FROM pgs_results WHERE z_score IS NOT NULL
  `)[0];
  const extremeRate = stats.extreme / stats.total;
  checks.push({ name: 'Extreme z-scores (>10σ) < 5%', pass: extremeRate < 0.05, detail: `${(extremeRate*100).toFixed(1)}% (${stats.extreme}/${stats.total})` });

  // Check 3: No NaN/null best PGS
  const nullBest = qr(`SELECT COUNT(*) as n FROM trait_results WHERE best_pgs_id IS NULL`)[0]?.n || 0;
  checks.push({ name: 'All traits have a best PGS', pass: nullBest === 0, detail: `${nullBest} missing` });

  // Check 4: Cross-individual consistency (same trait, z-scores within 3σ of each other)
  const divergent = qr(`
    SELECT trait_id, MAX(overall_z_score) - MIN(overall_z_score) as z_spread
    FROM trait_results
    GROUP BY trait_id HAVING z_spread > 10
  `);
  checks.push({ name: 'Cross-individual z-score spread < 10σ', pass: divergent.length === 0, detail: `${divergent.length} divergent traits` });

  // Check 5: No PGS with 0 expected variants
  const zeroExpected = qr(`SELECT COUNT(*) as n FROM pgs_results WHERE expected_variants = 0`)[0]?.n || 0;
  checks.push({ name: 'No PGS with 0 expected variants', pass: zeroExpected === 0, detail: `${zeroExpected} found` });

  // Check 6: Insufficient data rate
  const insufficientRate = qr(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN insufficient_data THEN 1 ELSE 0 END) as insufficient
    FROM pgs_results
  `)[0];
  const insRate = insufficientRate.insufficient / insufficientRate.total;
  checks.push({ name: 'Insufficient data < 20%', pass: insRate < 0.20, detail: `${(insRate*100).toFixed(1)}%` });

  // Print results
  let passed = 0, failed = 0;
  for (const c of checks) {
    const icon = c.pass ? chalk.green('✓') : chalk.red('✗');
    const detail = chalk.gray(`(${c.detail})`);
    console.log(`  ${icon} ${c.name} ${detail}`);
    if (c.pass) passed++; else failed++;
  }

  console.log(`\n  ${chalk.green(passed + ' passed')}, ${failed > 0 ? chalk.red(failed + ' failed') : chalk.green('0 failed')}\n`);
  return failed === 0;
}

// ── CLI Router ──────────────────────────────────────────────────────────────

const COMMANDS = {
  summary:   { label: '📊 Summary — Overall score statistics', fn: () => { summary(); } },
  extremes:  { label: '🔴 Extremes — Analyze extreme z-scores', fn: () => { extremes(); } },
  coverage:  { label: '📉 Coverage — Low coverage PGS analysis', fn: () => { coverage(); } },
  sds:       { label: '🔬 Small SDs — Suspiciously small standard deviations', fn: () => { smallSDs(); } },
  audit:     { label: '🔍 Audit — PGS selection validation', fn: (args) => {
    const filterTrait = args.find(a => /^[A-Z]+_\d+/.test(a));
    const flagsOnly = args.includes('--flags');
    audit(filterTrait, flagsOnly);
  }},
  validate:  { label: '✅ Validate — Quick pass/fail checks', fn: () => { validate(); } },
  all:       { label: '🧬 All — Run everything', fn: () => {
    summary(); extremes(); coverage(); smallSDs();
    console.log(chalk.green('\n✓ Analysis complete\n'));
  }},
};

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd && cmd !== '--help' && COMMANDS[cmd]) {
  COMMANDS[cmd].fn(args.slice(1));
} else if (cmd === '--help') {
  console.log(`\n🧬 Asili Score Analysis\n\nUsage:\n  pnpm scores              Interactive menu\n  pnpm scores <command>    Run a specific analysis\n\nCommands:`);
  for (const [name, { label }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(12)} ${label}`);
  }
  console.log(`\nAudit options:\n  pnpm scores audit EFO_0004340   Audit specific trait\n  pnpm scores audit --flags       Only show flagged traits\n`);
} else if (cmd && !COMMANDS[cmd]) {
  // Maybe they passed a trait ID directly (shortcut for audit)
  if (/^[A-Z]+_\d+/.test(cmd)) {
    audit(cmd, false);
  } else {
    console.error(chalk.red(`Unknown command: "${cmd}"`));
    console.error(`Run ${chalk.cyan('pnpm scores --help')} for available commands`);
    process.exit(1);
  }
} else {
  // Interactive menu
  const prompts = (await import('prompts')).default;

  const { selection } = await prompts({
    type: 'select',
    name: 'selection',
    message: 'What would you like to analyze?',
    choices: Object.entries(COMMANDS).map(([value, { label }]) => ({ title: label, value }))
  });

  if (!selection) { console.log('Cancelled.'); process.exit(0); }
  COMMANDS[selection].fn(args);
}
