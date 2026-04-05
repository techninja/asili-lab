#!/usr/bin/env node
/**
 * CLI score calculator — runs the same pipeline as the hybrid calc server
 * but directly from the command line without needing the server running.
 *
 * Usage:
 *   pnpm scores calc                    — Interactive: pick individual + trait
 *   pnpm scores calc all                — All individuals × all traits
 *   pnpm scores calc EFO_0004340        — All individuals × one trait
 *   pnpm scores calc 1769791316003_Ethan EFO_0004340  — One individual × one trait
 */

import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import prompts from 'prompts';
import '../packages/pipeline/lib/env.js';

import { PATHS } from '../packages/core/src/constants/paths.js';
import { PGSScorer } from '../packages/core/src/genomic-processor/scorer.js';
import { createDNASource } from '../packages/core/src/genomic-processor/index.js';
import { DuckDBServerAdapter } from '../packages/core/src/genomic-processor/adapters/duckdb-server.js';
import { ServerStorageManager } from '../packages/core/src/storage-manager/server.js';
import { getTraitPGS } from '../packages/pipeline/lib/trait-db.js';
import { getPGS, getPGSPerformance } from '../packages/pipeline/lib/pgs-db.js';
import { closeConnection } from '../packages/pipeline/lib/shared-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(ROOT, 'server-data');
const MANIFEST_JSON = path.join(ROOT, 'data_out', 'trait_manifest.json');

async function loadManifest() {
  const { readFile } = await import('fs/promises');
  const raw = await readFile(MANIFEST_JSON, 'utf8');
  return JSON.parse(raw);
}

async function calcTrait(traitId, individualId, duckdb, storage, manifest) {
  const trait = manifest.traits?.[traitId];
  if (!trait) throw new Error(`Trait ${traitId} not found in manifest`);

  const unifiedPath = path.join(
    STORAGE_DIR,
    'unified',
    `${individualId}.parquet`
  );
  const imputedPath = path.join(
    STORAGE_DIR,
    'imputed',
    `${individualId}_imputed.parquet`
  );
  const traitUrl = PATHS.getTraitFile(traitId);

  const hasUnified = await duckdb.fileExists(unifiedPath);
  const hasImputed = !hasUnified && (await duckdb.fileExists(imputedPath));

  let genotypedVariants = null;
  if (!hasUnified && !hasImputed) {
    genotypedVariants = await storage.getVariants(individualId);
  }

  const dnaSource = await createDNASource({
    individualId,
    duckdb,
    unifiedPath: hasUnified ? unifiedPath : null,
    imputedPath: hasImputed ? imputedPath : null,
    genotypedVariants
  });

  // PGS variant counts
  const pgsCountRows = await duckdb.query(
    `SELECT pgs_id, COUNT(*) as n FROM '${traitUrl}' GROUP BY pgs_id`
  );
  const pgsVariantCounts = new Map(
    pgsCountRows.map(r => [r.pgs_id, Number(r.n)])
  );

  // Normalization params
  const normalizationParams = {};
  const pgsPerformanceMetrics = {};
  const pgsScores = await getTraitPGS(traitId);

  for (const { pgs_id } of pgsScores) {
    const pgs = await getPGS(pgs_id);
    if (!pgs) continue;
    const perfMetrics = await getPGSPerformance(pgs_id);
    const r2Metrics = perfMetrics.filter(
      m => m.metric_type === 'R²' || m.metric_type === 'PGS R2 (no covariates)'
    );
    const bestR2 =
      r2Metrics.length > 0
        ? Math.max(
            ...r2Metrics.map(m =>
              m.metric_value > 1 ? m.metric_value / 100 : m.metric_value
            )
          )
        : 0.05;

    normalizationParams[pgs_id] = {
      norm_mean: pgs.norm_mean,
      norm_sd: pgs.norm_sd,
      performance_weight: bestR2,
      variants_number:
        pgsVariantCounts.get(pgs_id) ||
        (pgs.variants_number ? Number(pgs.variants_number) : null)
    };
    pgsPerformanceMetrics[pgs_id] = { r2: bestR2 };
  }

  // Score
  const scorer = new PGSScorer(normalizationParams);

  if (hasUnified && dnaSource.scoreInDB) {
    const dbResults = await dnaSource.scoreInDB(traitUrl);
    scorer.loadFromDB(dbResults, pgsVariantCounts);
  } else {
    if (!hasUnified) {
      const origMatch = dnaSource.matchVariants.bind(dnaSource);
      dnaSource.matchVariants = (url, opts = {}) =>
        origMatch(url, { ...opts, duckdb });
    }
    await scorer.score(dnaSource, traitUrl, pgsVariantCounts);
  }

  const result = await scorer.finalize(
    trait.trait_type || 'disease_risk',
    trait.unit || null,
    trait.phenotype_mean || null,
    trait.phenotype_sd || null,
    pgsPerformanceMetrics
  );

  // Fetch top variants + chr totals for top 4 PGS (matches calc server behavior)
  if (hasUnified && dnaSource.fetchTopVariants) {
    const top4Ids = Object.entries(result.pgsDetails || {})
      .sort((a, b) => (b[1].qualityScore || 0) - (a[1].qualityScore || 0))
      .slice(0, 4)
      .map(([id]) => id);
    if (top4Ids.length > 0) {
      const [topVariantRows, chrTotalRows] = await Promise.all([
        dnaSource.fetchTopVariants(top4Ids),
        dnaSource.fetchChrTotals(top4Ids)
      ]);
      scorer.loadTopVariants(topVariantRows);
      for (const row of chrTotalRows) {
        const bd = result.pgsBreakdown?.[row.pgs_id];
        if (!bd) continue;
        if (!bd.chrTotals) bd.chrTotals = {};
        bd.chrTotals[String(row.chr)] = Number(row.cnt);
      }

      // Cross-individual genotype lookup for top variants
      const allIndividuals = await storage.getIndividuals();
      const positions = [...new Set(topVariantRows.map(r => r.variant_id))];
      if (positions.length > 0) {
        for (const ind of allIndividuals) {
          if (ind.id === individualId) continue;
          const otherPath = path.join(
            STORAGE_DIR,
            'unified',
            `${ind.id}.parquet`
          );
          if (!(await duckdb.fileExists(otherPath))) continue;
          const posFilter = positions
            .map(p => {
              const [c, pos] = p.split(':');
              return `(chr=${c} AND pos=${pos})`;
            })
            .join(' OR ');
          const rows = await duckdb.query(
            `SELECT variant_id FROM '${otherPath}' WHERE ${posFilter}`
          );
          const genoMap = new Map(
            rows.map(r => {
              const parts = r.variant_id.split(':');
              return [
                `${parts[0]}:${parts[1]}`,
                parts.length >= 4 ? `${parts[2]}${parts[3]}` : '?'
              ];
            })
          );
          for (const [, details] of scorer.calculator.pgsDetails) {
            for (const v of details.topVariants || []) {
              const key = v.rsid.split(':').slice(0, 2).join(':');
              const geno = genoMap.get(key);
              if (geno) {
                if (!v.otherGenotypes) v.otherGenotypes = {};
                v.otherGenotypes[ind.id] = {
                  emoji: ind.emoji,
                  name: ind.name,
                  genotype: geno
                };
              }
            }
          }
        }
      }
    }
  }

  const riskData = {
    zScore: result.zScore,
    percentile: result.percentile,
    confidence: result.confidence,
    bestPGS: result.bestPGS,
    bestPGSPerformance: result.bestPGSPerformance,
    bestPGSQualityScore: result.bestPGSQualityScore,
    pgsBreakdown: result.pgsBreakdown,
    pgsDetails: result.pgsDetails,
    matchedVariants: result.totalMatches || 0,
    totalVariants: [...pgsVariantCounts.values()].reduce((a, b) => a + b, 0),
    calculatedAt: new Date().toISOString(),
    phenotype_mean: trait.phenotype_mean,
    phenotype_sd: trait.phenotype_sd,
    reference_population: trait.reference_population,
    trait_type: trait.trait_type,
    unit: trait.unit
  };
  if (trait.trait_type === 'quantitative' && result.value !== undefined) {
    riskData.value = result.value;
  }

  await storage.storeRiskScore(individualId, traitId, riskData);
  return riskData;
}

async function main() {
  const args = process.argv.slice(2);
  const manifest = await loadManifest();
  const traitIds = Object.keys(manifest.traits || {});

  const storage = new ServerStorageManager({ dataDir: STORAGE_DIR });
  await storage.initialize();
  const individuals = await storage.getIndividuals();

  if (individuals.length === 0) {
    console.error(chalk.red('No individuals found in storage.'));
    process.exit(1);
  }

  // Parse args: calc all | calc <traitId> | calc <individualId> <traitId>
  let targetIndividuals = individuals;
  let targetTraits = traitIds;

  if (args[0] === 'all') {
    // all individuals × all traits — no change needed
  } else if (args[0] && args[1]) {
    // individual + trait
    const ind = individuals.find(
      i => i.id === args[0] || `${i.id}_${i.name}` === args[0]
    );
    if (!ind) {
      console.error(chalk.red(`Individual not found: ${args[0]}`));
      process.exit(1);
    }
    if (!manifest.traits?.[args[1]]) {
      console.error(chalk.red(`Trait not found: ${args[1]}`));
      process.exit(1);
    }
    targetIndividuals = [ind];
    targetTraits = [args[1]];
  } else if (args[0] && manifest.traits?.[args[0]]) {
    // just a trait ID — all individuals
    targetTraits = [args[0]];
  } else if (!args[0]) {
    // Interactive
    const { indChoice } = await prompts({
      type: 'select',
      name: 'indChoice',
      message: 'Select individual:',
      choices: [
        { title: 'All individuals', value: 'all' },
        ...individuals.map(i => ({ title: `${i.name || i.id}`, value: i.id }))
      ]
    });
    if (!indChoice) return;
    if (indChoice !== 'all')
      targetIndividuals = individuals.filter(i => i.id === indChoice);

    const { traitChoice } = await prompts({
      type: 'select',
      name: 'traitChoice',
      message: 'Select trait:',
      choices: [
        { title: 'All traits', value: 'all' },
        ...traitIds.map(id => ({
          title: `${manifest.traits[id].name} (${id})`,
          value: id
        }))
      ]
    });
    if (!traitChoice) return;
    if (traitChoice !== 'all') targetTraits = [traitChoice];
  } else {
    console.error(chalk.red(`Unknown argument: ${args[0]}`));
    process.exit(1);
  }

  // Specific trait = force recalc; batch = skip existing scores
  const forceRecalc = targetTraits.length === 1;

  let skipped = 0;
  const calcPlan = [];
  for (const individual of targetIndividuals) {
    for (const traitId of targetTraits) {
      if (!forceRecalc) {
        const existing = await storage
          .getCachedRiskScore(individual.id, traitId)
          .catch(() => null);
        if (existing) {
          skipped++;
          continue;
        }
      }
      calcPlan.push({ individual, traitId });
    }
  }

  const total = calcPlan.length;
  const skipMsg =
    skipped > 0 ? chalk.gray(` (${skipped} already scored, skipping)`) : '';
  console.log(
    chalk.cyan(
      `\n🧬 Calculating ${total} scores for ${targetIndividuals.length} individual(s) × ${targetTraits.length} trait(s)${skipMsg}\n`
    )
  );

  if (total === 0) {
    console.log(chalk.green('✅ All scores up to date.\n'));
    closeConnection();
    process.exit(0);
  }

  const duckdb = new DuckDBServerAdapter();
  await duckdb.initialize();

  let done = 0;
  let errors = 0;
  const start = Date.now();
  let currentIndId = null;

  for (const { individual, traitId } of calcPlan) {
    const indId = individual.id;
    const indName = individual.name || individual.id;
    if (indId !== currentIndId) {
      currentIndId = indId;
      const indIdx = targetIndividuals.indexOf(individual) + 1;
      console.log(
        chalk.bold(`\n👤 [${indIdx}/${targetIndividuals.length}] ${indName}`)
      );
    }
    const traitName = manifest.traits[traitId]?.name || traitId;
    done++;
    try {
      const t0 = Date.now();
      process.stdout.write(chalk.gray(`  ⏳ ${traitName} (${traitId})...`));
      const result = await calcTrait(traitId, indId, duckdb, storage, manifest);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const pct =
        result.percentile != null
          ? `${result.percentile.toFixed(1)}%ile`
          : 'N/A';
      const z =
        result.zScore != null ? `z=${result.zScore.toFixed(2)}` : 'z=N/A';
      const matched = result.matchedVariants?.toLocaleString() || '?';
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
      console.log(
        chalk.green(
          `  ✓ [${done}/${total}] ${traitName}: ${z} ${pct} | ${matched} variants | ${elapsed}s`
        )
      );
    } catch (err) {
      errors++;
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
      console.log(
        chalk.red(`  ✗ [${done}/${total}] ${traitName}: ${err.message}`)
      );
    }
  }

  const totalElapsed = (Date.now() - start) / 1000;
  const avgPer = done > 0 ? (totalElapsed / done).toFixed(1) : '?';
  const h = Math.floor(totalElapsed / 3600);
  const m = Math.floor((totalElapsed % 3600) / 60);
  const s = Math.floor(totalElapsed % 60);
  const elapsed = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  console.log(
    chalk.cyan(`\n✅ Done: ${done - errors} succeeded, ${errors} failed`)
  );
  console.log(
    chalk.cyan(`   Total: ${elapsed} (${avgPer}s avg per calculation)\n`)
  );

  closeConnection();
  process.exit(0);
}

main().catch(err => {
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});
