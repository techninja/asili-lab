/**
 * LD clumping using gnomAD LD reference data with r² threshold
 * Keeps strongest variants and removes correlated ones based on actual LD
 */

import { existsSync } from 'fs';
import path from 'path';

const LD_PARQUET_DIR = process.env.GENOMES_LD_PARQUET;
const R2_THRESHOLD = 0.8; // Remove variants with r² > 0.8
const MIN_VARIANTS_AFTER_CLUMP = 8; // Minimum variants to keep for usefulness

/**
 * Generate SQL to clump variants using gnomAD LD data
 * Removes variants in high LD (r² > 0.8) while keeping strongest
 */
export function generateLDClumpingSQL(tableName = 'pgs_staging', chromosome) {
  if (!LD_PARQUET_DIR || !existsSync(LD_PARQUET_DIR)) {
    console.log('    ⚠️  gnomAD LD data not available, using distance-based clumping');
    return generateDistanceClumpingSQL(tableName);
  }

  const ldFile = path.join(LD_PARQUET_DIR, `chr${chromosome}_CEU_ld.parquet`);
  if (!existsSync(ldFile)) {
    console.log(`    ⚠️  LD data not found for chr${chromosome}, using distance-based clumping`);
    return generateDistanceClumpingSQL(tableName);
  }

  return `
    -- LD-based clumping using gnomAD r² data (memory-optimized)
    WITH variant_positions AS (
      SELECT DISTINCT chr_position
      FROM ${tableName}
      WHERE chr_name = '${chromosome}'
    ),
    relevant_ld AS (
      SELECT pos1, pos2, r2
      FROM '${ldFile}'
      WHERE r2 > ${R2_THRESHOLD}
        AND pos1 IN (SELECT chr_position FROM variant_positions)
        AND pos2 IN (SELECT chr_position FROM variant_positions)
    ),
    variant_strength AS (
      SELECT 
        variant_id,
        pgs_id,
        chr_position,
        ABS(effect_weight) as strength,
        ROW_NUMBER() OVER (
          PARTITION BY pgs_id
          ORDER BY ABS(effect_weight) DESC
        ) as global_rank
      FROM ${tableName}
      WHERE chr_name = '${chromosome}'
    ),
    ld_pairs AS (
      SELECT 
        v1.variant_id as var1,
        v2.variant_id as var2,
        v1.pgs_id,
        v1.strength as strength1,
        v2.strength as strength2,
        v1.global_rank as rank1,
        v2.global_rank as rank2
      FROM variant_strength v1
      JOIN relevant_ld ld ON v1.chr_position = ld.pos1
      JOIN variant_strength v2 ON (
        v2.chr_position = ld.pos2 AND v2.pgs_id = v1.pgs_id
      )
      WHERE v1.variant_id != v2.variant_id
    ),
    variants_to_remove AS (
      SELECT DISTINCT
        CASE 
          WHEN strength1 > strength2 THEN var2
          WHEN strength1 < strength2 THEN var1
          ELSE CASE WHEN var1 < var2 THEN var2 ELSE var1 END
        END as variant_id,
        pgs_id
      FROM ld_pairs
      WHERE CASE 
        WHEN strength1 > strength2 THEN rank2
        ELSE rank1
      END > ${MIN_VARIANTS_AFTER_CLUMP}
    )
    DELETE FROM ${tableName}
    WHERE chr_name = '${chromosome}'
      AND (variant_id, pgs_id) IN (
        SELECT variant_id, pgs_id FROM variants_to_remove
      );
  `;
}

/**
 * Fallback: Distance-based clumping when LD data unavailable
 */
function generateDistanceClumpingSQL(tableName = 'pgs_staging') {
  const CLUMP_WINDOW = 250000;
  return `
    WITH ranked_variants AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY pgs_id, chr_name, FLOOR(chr_position / ${CLUMP_WINDOW})
          ORDER BY ABS(effect_weight) DESC
        ) as rank_in_window,
        ROW_NUMBER() OVER (
          PARTITION BY pgs_id
          ORDER BY ABS(effect_weight) DESC
        ) as global_rank
      FROM ${tableName}
    ),
    variants_to_remove AS (
      SELECT variant_id, pgs_id
      FROM ranked_variants
      WHERE rank_in_window > 1
        AND global_rank > ${MIN_VARIANTS_AFTER_CLUMP}
    )
    DELETE FROM ${tableName}
    WHERE (variant_id, pgs_id) IN (
      SELECT variant_id, pgs_id FROM variants_to_remove
    );
  `;
}

/**
 * Generate clumping SQL (wrapper for backward compatibility)
 */
export function generateClumpingSQL(tableName = 'pgs_staging') {
  return generateDistanceClumpingSQL(tableName);
}

/**
 * Check if clumping should be applied to a PGS
 */
export function shouldClumpPGS(pgsMetadata) {
  return pgsMetadata?.needs_clumping === true;
}
