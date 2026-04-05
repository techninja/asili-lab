# LD Clumping — Removed

## History

The ETL pipeline previously included distance-based LD clumping that attempted to remove correlated variants from PGS scores. This was removed because:

1. **Every PGS in the PGS Catalog already handles LD** through its construction method (LDpred, PRS-CS, C+T, snpnet, GWAS-significant selection, etc.)
2. The distance-based fallback (250kb windows) **destroyed data** — it removed all variants from dozens of PGS scores across multiple traits
3. Maintaining a method recognition list was a losing game — new methods constantly appeared and got incorrectly clumped
4. The `variants_in_parquet` vs `variants_number` distinction only existed because of clumping

## Current Behavior

The ETL pipeline imports PGS variants exactly as provided by the PGS Catalog's harmonized GRCh38 scoring files. No variants are removed or modified during import.

## Files Removed/Unused

- `packages/pipeline/lib/ld-clumping.js` — can be deleted
- `packages/pipeline/lib/ld-detector.js` — can be deleted
- `pgs_scores.ld_aware` column — no longer written
- `pgs_scores.needs_clumping` column — no longer written
