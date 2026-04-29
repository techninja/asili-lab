import fs from 'fs/promises';
import path from 'path';
import './lib/env.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'data_out';
const CACHE_DIR = process.env.CACHE_DIR || '/media/techninja/gnomad/asili_cache';
const PGS_CACHE = path.join(CACHE_DIR, 'www.pgscatalog.org');
const DETAIL_DIR = path.join(OUTPUT_DIR, 'pgs_detail');

async function buildPerfMap() {
  const dir = path.join(PGS_CACHE, 'rest_performance_search');
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
  const map = new Map();
  for (const file of files) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
      for (const r of raw.data?.results || []) {
        const id = r.associated_pgs_id;
        if (!id) continue;
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(r);
      }
    } catch { /* skip corrupt files */ }
  }
  return map;
}

function buildMetrics(pm) {
  const out = [];
  for (const arr of [pm.effect_sizes, pm.class_acc, pm.othermetrics]) {
    for (const m of arr || []) {
      const entry = { type: m.name_short, value: m.estimate };
      if (m.ci_lower != null && m.ci_upper != null) entry.ci = [m.ci_lower, m.ci_upper];
      out.push(entry);
    }
  }
  return out;
}

function buildEvaluations(perfResults) {
  const evals = [];
  let evalN = 0;
  for (const r of perfResults) {
    const samples = r.sampleset?.samples || [];
    const n = samples.reduce((s, x) => s + (x.sample_number || 0), 0);
    evalN += n;
    const ancestry = samples[0]?.ancestry_broad || 'NR';
    const cohort = samples[0]?.cohorts?.[0]?.name_short || null;
    const metrics = buildMetrics(r.performance_metrics || {});
    if (metrics.length) evals.push({ ancestry, n, cohort, metrics });
  }
  return { evals, evalN };
}

function buildDetail(score, perfResults, cacheTimestamp) {
  const d = score;
  const pub = d.publication || {};
  const { evals, evalN } = buildEvaluations(perfResults);

  return {
    id: d.id,
    name: d.name || null,
    method: d.method_name || null,
    method_params: d.method_params || null,
    weight_type: d.weight_type || null,
    variants: d.variants_number || 0,
    publication: {
      id: pub.id, title: pub.title, doi: pub.doi,
      pmid: pub.PMID || null, author: pub.firstauthor || null,
      date: pub.date_publication || null,
    },
    ancestry: {
      gwas: d.ancestry_distribution?.gwas?.dist || {},
      eval: d.ancestry_distribution?.eval?.dist || {},
    },
    samples: {
      gwas: (d.samples_variants || []).reduce((s, x) => s + (x.sample_number || 0), 0),
      training: (d.samples_training || []).reduce((s, x) => s + (x.sample_number || 0), 0),
      eval: evalN,
    },
    evaluations: evals,
    license: d.license || null,
    date_release: d.date_release || null,
    cache_date: cacheTimestamp ? new Date(cacheTimestamp).toISOString().slice(0, 10) : null,
  };
}

export async function exportPgsDetail() {
  const manifest = JSON.parse(await fs.readFile(path.join(OUTPUT_DIR, 'trait_manifest.json'), 'utf8'));
  const pgsIds = Object.keys(manifest.pgs || {});
  await fs.mkdir(DETAIL_DIR, { recursive: true });

  console.log(`📦 Building performance lookup from cache...`);
  const perfMap = await buildPerfMap();

  let written = 0, skipped = 0, maxRelease = '';
  const CONCURRENCY = 20;

  for (let i = 0; i < pgsIds.length; i += CONCURRENCY) {
    await Promise.all(pgsIds.slice(i, i + CONCURRENCY).map(async (pgsId) => {
      const cachePath = path.join(PGS_CACHE, `rest_score_${pgsId}`, 'no-params.json');
      let raw;
      try { raw = JSON.parse(await fs.readFile(cachePath, 'utf8')); } catch {
        console.warn(`   ⚠ No cache for ${pgsId}, skipping`);
        skipped++;
        return;
      }
      const score = raw.data;
      if (score.date_release && score.date_release > maxRelease) maxRelease = score.date_release;
      const detail = buildDetail(score, perfMap.get(pgsId) || [], raw.timestamp);
      await fs.writeFile(path.join(DETAIL_DIR, `${pgsId}.json`), JSON.stringify(detail));
      written++;
    }));
  }

  await fs.writeFile(path.join(DETAIL_DIR, '_build.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    pgs_catalog_version: maxRelease || null,
    source: 'PGS Catalog (https://www.pgscatalog.org)',
    license: 'PGS Catalog data is licensed under CC BY 4.0. Individual scores may have additional licensing — see each PGS entry.',
    terms: 'https://www.ebi.ac.uk/about/terms-of-use/',
    citation: 'Lambert et al. (2021) The Polygenic Score Catalog. Nature Genetics. doi:10.1038/s41588-021-00783-5',
    cache_dir: CACHE_DIR,
    pgs_count: written,
    skipped,
  }, null, 2));

  console.log(`✓ Exported ${written} PGS detail files (${skipped} skipped)`);
}
