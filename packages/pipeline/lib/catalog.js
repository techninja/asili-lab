import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConnection } from './shared-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function loadTraitCatalog() {
  const catalogPath = path.join(__dirname, '../trait_catalog.json');
  const data = await fs.readFile(catalogPath, 'utf8');
  return JSON.parse(data);
}

export async function getTraitConfigs(catalog) {
  try {
    const configs = {};
    console.log('Fetching all traits from database...');
    const conn = await getConnection();
    const allTraits = await new Promise((resolve, reject) => {
      conn.all('SELECT * FROM traits ORDER BY name', (err, rows) => {
        if (err) {
          console.error('[catalog.js] Error querying traits:', err);
          reject(err);
        } else {
          console.log(`[catalog.js] Query returned ${rows?.length || 0} rows`);
          resolve(rows);
        }
      });
    });
    console.log(`✓ Fetched ${allTraits.length} traits`);
    const traitMap = Object.fromEntries(allTraits.map(t => [t.trait_id, t]));

    const catalogTraitIds = Object.keys(catalog.traits);
    console.log(`Processing ${catalogTraitIds.length} traits from catalog...`);

    for (const [traitId, trait] of Object.entries(catalog.traits)) {
      const pgsScores = await new Promise((resolve, reject) => {
        conn.all('SELECT pgs_id, performance_weight FROM trait_pgs WHERE trait_id = ?', [traitId], (err, rows) => err ? reject(err) : resolve(rows));
      });
      const pgsIds = pgsScores.map(p => p.pgs_id);
      
      const normalizationParams = {};
      for (const { pgs_id, performance_weight } of pgsScores) {
        const pgs = await new Promise((resolve, reject) => {
          conn.all('SELECT * FROM pgs_scores WHERE pgs_id = ?', [pgs_id], (err, rows) => err ? reject(err) : resolve(rows[0]));
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
      
      const traitInfo = traitMap[traitId];
      
      configs[traitId] = {
        pgs_ids: pgsIds,
        normalization_params: normalizationParams,
        name: trait.title,
        trait_id: traitId,
        expected_variants: traitInfo?.expected_variants || 0,
        description: trait.description || '',
        weight: 1.0
      };
    }

    console.log(`✓ Processed ${Object.keys(configs).length} trait configs`);
    return configs;
  } catch (error) {
    console.error('Error in getTraitConfigs:', error);
    console.error('Stack:', error.stack);
    throw error;
  }
}
