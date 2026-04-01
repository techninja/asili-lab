import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConnection } from './shared-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALLOWLISTS_DIR = path.join(__dirname, '../allowlists');

export async function loadAllowlist(tier) {
  if (!tier || tier === 'local') return null; // no filtering for local/docker tier

  const allowlistPath = path.join(ALLOWLISTS_DIR, `${tier}.json`);
  try {
    const data = await fs.readFile(allowlistPath, 'utf8');
    const allowlist = JSON.parse(data);
    if (allowlist.traits.includes('*')) return null; // wildcard = no filtering
    return new Set(allowlist.traits);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`⚠ Allowlist not found: ${allowlistPath}, processing all traits`);
      return null;
    }
    throw error;
  }
}

export async function getTraitConfigs(tier) {
  const allowlist = await loadAllowlist(tier);
  const conn = await getConnection();
  const singleTrait = process.env.SINGLE_TRAIT;

  const query = (sql, params = []) => new Promise((resolve, reject) => {
    conn.all(sql, ...([params.length ? params : [], (err, rows) => err ? reject(err) : resolve(rows)].flat()));
  });

  // Load traits — single query, filtered at DB level when possible
  let allTraits;
  if (singleTrait) {
    const ids = singleTrait.split(',').map(s => s.trim());
    const inClause = ids.map(id => `'${id}'`).join(',');
    allTraits = await query(
      `SELECT * FROM traits WHERE trait_id IN (${inClause}) OR name IN (${inClause})`
    );
  } else {
    allTraits = await query('SELECT * FROM traits ORDER BY name');
  }

  const filtered = allowlist
    ? allTraits.filter(t => allowlist.has(t.trait_id))
    : allTraits;

  console.log(`✓ ${filtered.length} traits loaded (tier: ${tier || 'local'})`);

  // Batch load all PGS mappings + scores in two queries instead of N+1
  const traitIds = filtered.map(t => t.trait_id);
  const inClause = traitIds.map(id => `'${id}'`).join(',');

  const allPgs = traitIds.length > 0
    ? await query(`SELECT tp.trait_id, tp.pgs_id, tp.performance_weight,
        ps.norm_mean, ps.norm_sd, ps.weight_type, ps.method_name, ps.variants_number
      FROM trait_pgs tp
      LEFT JOIN pgs_scores ps ON tp.pgs_id = ps.pgs_id
      WHERE tp.trait_id IN (${inClause})
      ORDER BY tp.trait_id, tp.pgs_id`)
    : [];

  // Group by trait
  const pgsByTrait = new Map();
  for (const row of allPgs) {
    if (!pgsByTrait.has(row.trait_id)) pgsByTrait.set(row.trait_id, []);
    pgsByTrait.get(row.trait_id).push(row);
  }

  const configs = {};
  for (const trait of filtered) {
    const pgsRows = pgsByTrait.get(trait.trait_id) || [];
    const normalizationParams = {};
    for (const row of pgsRows) {
      if (row.norm_mean != null || row.norm_sd != null || row.weight_type) {
        normalizationParams[row.pgs_id] = {
          norm_mean: row.norm_mean || 0,
          norm_sd: row.norm_sd || null,
          weight_type: row.weight_type,
          method: row.method_name,
          performance_weight: row.performance_weight || 0.5,
          variants_number: row.variants_number ? Number(row.variants_number) : null
        };
      }
    }

    configs[trait.trait_id] = {
      pgs_ids: pgsRows.map(p => p.pgs_id),
      normalization_params: normalizationParams,
      name: trait.editorial_name || trait.name,
      trait_id: trait.trait_id,
      expected_variants: trait.expected_variants || 0,
      description: trait.editorial_description || trait.description || '',
      weight: 1.0
    };
  }

  console.log(`✓ Processed ${Object.keys(configs).length} trait configs`);
  return configs;
}
