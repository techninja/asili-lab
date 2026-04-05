/**
 * Allele Key SQL Expression
 *
 * Deterministic hash of sorted allele pair for allele-aware JOINs.
 * See docs/ALLELE_KEY.md for full specification.
 *
 * Used by: ETL (processor-core, batched-processor), imputation (impute_user.py,
 * rebuild-unified.py), and scoring (unified.js).
 */

// DuckDB SQL expression that computes allele_key from a variant_id column.
// variant_id format: chr:pos:alleleA:alleleB
// Returns BIGINT — deterministic across CLI, Node, and Python DuckDB.
export const ALLELE_KEY_SQL = (col = 'variant_id') =>
  `('0x' || md5(LEAST(SPLIT_PART(${col},':',3),SPLIT_PART(${col},':',4)) || ':' || GREATEST(SPLIT_PART(${col},':',3),SPLIT_PART(${col},':',4)))[:15])::BIGINT`;

// Python-compatible string (same expression, for embedding in f-strings)
// Usage in Python: f"... {ALLELE_KEY_EXPR.replace('variant_id', col)} ..."
export const ALLELE_KEY_EXPR = ALLELE_KEY_SQL('variant_id');
