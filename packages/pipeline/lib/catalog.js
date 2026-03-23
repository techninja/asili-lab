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

  const allTraits = await new Promise((resolve, reject) => {
    conn.all('SELECT * FROM traits ORDER BY name', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

  const filtered = allowlist
    ? allTraits.filter(t => allowlist.has(t.trait_id))
    : allTraits;

  console.log(`✓ ${filtered.length} traits loaded (tier: ${tier || 'local'})`);

  const configs = {};
  for (const trait of filtered) {
    const pgsScores = await new Promise((resolve, reject) => {
      conn.all(
        'SELECT pgs_id, performance_weight FROM trait_pgs WHERE trait_id = ?',
        [trait.trait_id],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    const normalizationParams = {};
    for (const { pgs_id, performance_weight } of pgsScores) {
      const pgs = await new Promise((resolve, reject) => {
        conn.all(
          'SELECT * FROM pgs_scores WHERE pgs_id = ?',
          [pgs_id],
          (err, rows) => (err ? reject(err) : resolve(rows[0]))
        );
      });
      if (pgs) {
        normalizationParams[pgs_id] = {
          norm_mean: pgs.norm_mean || 0,
          norm_sd: pgs.norm_sd || null,
          weight_type: pgs.weight_type,
          method: pgs.method_name,
          performance_weight: performance_weight || 0.5,
          variants_number: pgs.variants_number ? Number(pgs.variants_number) : null
        };
      }
    }

    configs[trait.trait_id] = {
      pgs_ids: pgsScores.map(p => p.pgs_id),
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
