# LD Clumping

## Problem

Variants in Linkage Disequilibrium (LD) are inherited together and represent the same genetic signal. Summing their effects inflates PGS scores.

## Detection

The pipeline automatically detects if PGS scores need clumping based on method name and variant count. This is evaluated during `pnpm traits refresh` and stored as `needs_clumping` in the `pgs_scores` table.

**LD-Aware Methods** (no clumping needed):
- LDpred, LDpred2, LDpred-funct, LDpred-inf, LDpred-auto
- PRS-CS, PRS-CSx
- lassosum, SBLUP, SBayesR
- MegaPRS, JAMPred, DBSLMM

**Already-Clumped Methods** (no clumping needed):
- Clumping + Thresholding (C+T), Pruning + Thresholding (P+T)
- PRSice, PRSice-2
- PRSmix, PRSmixPlus, PRSauto

**Safeguards:**
- PGS with <100 variants: skip clumping (too small for LD issues)
- PGS with >100K variants: skip clumping (genome-wide scores inherently account for LD through their construction, and distance-based clumping would destroy them)

**Needs Clumping:**
- Unknown methods with 100-100K variants

## Clumping Algorithm

### Distance-Based (fallback)

Used when gnomAD LD parquets are not available:

1. Divide each chromosome into 250kb windows
2. Keep strongest variant (highest |effect_weight|) per window per PGS
3. Protect top 8 variants globally from removal

### LD-Based (preferred)

Used when `GENOMES_LD_PARQUET` is set and contains per-chromosome LD files:

1. Load r² data for variant pairs in the PGS
2. For pairs with r² > 0.8, remove the weaker variant
3. Protect top 8 variants globally from removal

## Schema

```sql
-- pgs_scores table
ld_aware BOOLEAN        -- Method inherently accounts for LD
needs_clumping BOOLEAN  -- Requires clumping during ETL
```

## Pipeline Integration

1. **`pnpm traits refresh`**: Evaluates `getLDStatus()` for each PGS, stores `ld_aware` and `needs_clumping` in manifest DB
2. **`pnpm etl local`**: Reads `needs_clumping` from DB, applies clumping during parquet generation
3. **Output**: Clumped parquet files with independent variants

## Files

| File | Purpose |
|---|---|
| `packages/pipeline/lib/ld-detector.js` | Method detection + clumping decision |
| `packages/pipeline/lib/ld-clumping.js` | SQL generation for distance/LD-based clumping |
| `packages/pipeline/lib/processor.js` | Applies clumping during ETL |
