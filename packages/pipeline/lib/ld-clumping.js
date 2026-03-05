/**
 * LD clumping using distance-based approach with optional gnomAD filtering
 * Keeps strongest variants and removes nearby correlated ones
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';

const GNOMAD_DB_PATH = process.env.GNOMAD_DB_PATH;
const CLUMP_WINDOW = 250000; // 250kb
const MIN_AF = 0.001; // 0.1% MAF threshold

/**
 * Generate SQL to clump variants by chromosome position
 * Keeps top variant in each window per chromosome
 */
export function generateClumpingSQL(tableName = 'pgs_staging') {
  return `
    -- Distance-based clumping (250kb windows)
    -- Keep strongest variant in each window per chromosome
    WITH ranked_variants AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY pgs_id, chr_name, FLOOR(chr_position / ${CLUMP_WINDOW})
          ORDER BY ABS(effect_weight) DESC
        ) as rank_in_window
      FROM ${tableName}
    )
    DELETE FROM ${tableName}
    WHERE (variant_id, pgs_id) IN (
      SELECT variant_id, pgs_id 
      FROM ranked_variants 
      WHERE rank_in_window > 1
    );
  `;
}

/**
 * Filter variants by gnomAD allele frequency
 * Removes ultra-rare variants (AF < 0.1%) that may be errors
 */
export function filterByGnomAD(variants) {
  if (!GNOMAD_DB_PATH || !existsSync(GNOMAD_DB_PATH)) {
    console.log('    ⚠️  gnomAD not available, skipping AF filtering');
    return variants;
  }
  
  const gnomadDb = new Database(GNOMAD_DB_PATH, { readonly: true });
  const filtered = [];
  const MAX_BATCH = 500;
  
  for (let i = 0; i < variants.length; i += MAX_BATCH) {
    const batch = variants.slice(i, i + MAX_BATCH);
    const conditions = batch.map(() => '(chr = ? AND pos = ? AND ref = ? AND alt = ?)').join(' OR ');
    const params = batch.flatMap(v => [v.chr, v.pos, v.ref, v.alt]);
    const sql = `SELECT chr, pos, ref, alt, af FROM variants WHERE ${conditions}`;
    
    const rows = gnomadDb.prepare(sql).all(...params);
    const afMap = new Map(rows.map(r => [`${r.chr}:${r.pos}:${r.ref}:${r.alt}`, r.af]));
    
    batch.forEach(v => {
      const key = `${v.chr}:${v.pos}:${v.ref}:${v.alt}`;
      const af = afMap.get(key);
      if (!af || af >= MIN_AF) filtered.push(v.variant_id);
    });
  }
  
  gnomadDb.close();
  return filtered;
}

/**
 * Generate SQL to remove ultra-rare variants using gnomAD
 */
export function generateGnomADFilterSQL(tableName, variantIds) {
  const idList = variantIds.map(id => `'${id}'`).join(',');
  return `
    DELETE FROM ${tableName}
    WHERE variant_id NOT IN (${idList});
  `;
}

/**
 * Check if clumping should be applied to a PGS
 */
export function shouldClumpPGS(pgsMetadata) {
  return pgsMetadata?.needs_clumping === true;
}
