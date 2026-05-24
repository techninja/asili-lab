import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConnection } from './shared-db.js';
import { loadAllowlist } from './catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/output';
const OVERRIDES_PATH = path.join(__dirname, '..', 'trait_overrides.json');

export async function exportTraitManifestJSON() {
  const tier = process.env.ASILI_TIER || 'tier1_public';
  const allowlist = await loadAllowlist(tier);
  const conn = await getConnection();

  // Get all traits with their PGS associations
  const traits = await new Promise((resolve, reject) => {
    conn.all(
      `
      SELECT 
        t.trait_id,
        t.name,
        t.description,
        t.categories,
        t.expected_variants,
        t.estimated_unique_variants,
        t.emoji,
        t.editorial_name,
        t.editorial_description,
        t.trait_type,
        t.unit,
        t.phenotype_mean,
        t.phenotype_sd,
        t.reference_population
      FROM traits t
      ORDER BY t.name;
    `,
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });

  const manifest = {
    version: '1.0',
    generated_at: new Date().toISOString(),
    traits: {}
  };

  const PACKS_DIR = path.join(OUTPUT_DIR, 'packs');

  for (const trait of traits) {
    if (allowlist && !allowlist.has(trait.trait_id)) continue;

    const parquetFile = `${trait.trait_id.replace(/:/g, '_')}_hg38.parquet`;
    try {
      await fs.access(path.join(PACKS_DIR, parquetFile));
    } catch {
      continue; // skip traits without built parquet files
    }
    const pgsScores = await new Promise((resolve, reject) => {
      conn.all(
        `
        SELECT tp.pgs_id, tp.performance_weight
        FROM trait_pgs tp
        WHERE tp.trait_id = ?
        ORDER BY tp.pgs_id;
      `,
        [trait.trait_id],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    let categories = [];
    try {
      categories = trait.categories ? JSON.parse(trait.categories) : [];
    } catch (_e) {
      // If categories is not valid JSON, split by comma
      categories = trait.categories
        ? trait.categories
            .split(',')
            .map(c => c.trim())
            .filter(Boolean)
        : [];
    }

    manifest.traits[trait.trait_id] = {
      trait_id: trait.trait_id,
      name: trait.editorial_name || trait.name,
      description: trait.editorial_description || trait.description,
      emoji: trait.emoji || '',
      trait_type: trait.trait_type || 'disease_risk',
      unit: trait.unit || null,
      phenotype_mean: trait.phenotype_mean || null,
      phenotype_sd: trait.phenotype_sd || null,
      reference_population: trait.reference_population || null,
      categories: categories,
      expected_variants: trait.expected_variants
        ? Number(trait.expected_variants)
        : 0,
      estimated_unique_variants: trait.estimated_unique_variants
        ? Number(trait.estimated_unique_variants)
        : 0,
      pgs_count: pgsScores.length,
      file_path: `packs/asili/${trait.trait_id.replace(/:/g, '_')}_hg38.asili`
    };
  }

  // Merge display-only fields from trait_overrides.json
  try {
    const overrides = JSON.parse(await fs.readFile(OVERRIDES_PATH, 'utf8'));
    for (const [traitId, entry] of Object.entries(manifest.traits)) {
      const ov = overrides[traitId];
      if (!ov) continue;
      if (ov.cover_image) entry.cover_image = ov.cover_image;
      if (ov.score_interpretation) entry.score_interpretation = ov.score_interpretation;
      if (ov.value_display) entry.value_display = ov.value_display;
      if (ov.phenotype_mean != null) entry.phenotype_mean = ov.phenotype_mean;
      if (ov.phenotype_sd != null) entry.phenotype_sd = ov.phenotype_sd;
      if (ov.reference_population) entry.reference_population = ov.reference_population;
    }
  } catch { /* overrides file missing — skip */ }

  // Collect all PGS IDs referenced by included traits
  const allPgsIds = new Set();
  for (const trait of Object.values(manifest.traits)) {
    const rows = await new Promise((resolve, reject) => {
      conn.all(
        'SELECT pgs_id FROM trait_pgs WHERE trait_id = ?',
        [trait.trait_id],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    for (const r of rows) allPgsIds.add(r.pgs_id);
  }

  // Bulk-fetch PGS metadata
  if (allPgsIds.size > 0) {
    const pgsRows = await new Promise((resolve, reject) => {
      conn.all(
        'SELECT pgs_id, method_name, weight_type, variants_number FROM pgs_scores',
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    const pgsMap = new Map(pgsRows.map(r => [r.pgs_id, r]));

    // Best R² per PGS
    const perfRows = await new Promise((resolve, reject) => {
      conn.all(
        `SELECT pgs_id, MAX(CASE WHEN metric_value > 1 THEN metric_value / 100.0 ELSE metric_value END) as best_r2
         FROM pgs_performance
         WHERE metric_type IN ('R²', 'PGS R2 (no covariates)', 'PGS R2  (no covariates)')
         GROUP BY pgs_id`,
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    const r2Map = new Map(perfRows.map(r => [r.pgs_id, r.best_r2]));

    manifest.pgs = {};
    for (const pgsId of allPgsIds) {
      const row = pgsMap.get(pgsId);
      if (!row) continue;
      const entry = {
        method: row.method_name || null,
        weightType: row.weight_type || null,
        variantsNumber: row.variants_number ? Number(row.variants_number) : null
      };
      const r2 = r2Map.get(pgsId);
      if (r2 != null) entry.r2 = Number(r2);
      manifest.pgs[pgsId] = entry;
    }
  }

  const outputPath = path.join(OUTPUT_DIR, 'trait_manifest.json');
  await fs.writeFile(outputPath, JSON.stringify(manifest, null, 2));
  console.log(
    `✓ Exported trait manifest: ${Object.keys(manifest.traits).length} traits, ${Object.keys(manifest.pgs || {}).length} PGS`
  );

  return manifest;
}
