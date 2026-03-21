# LD Clumping

## Problem

Variants in Linkage Disequilibrium (LD) are inherited together and represent the same genetic signal. Summing their effects inflates PGS scores.

## Solution

**Automatic LD Detection & Clumping with gnomAD Quality Control**

### Detection

The pipeline automatically detects if PGS scores need clumping based on method:

**LD-Aware Methods** (no clumping needed):

- LDpred, LDpred2, PRS-CS, lassosum, SBayesR
- Clumping + Thresholding (C+T)

**Needs Clumping**:

- Unknown methods with >100 variants
- Raw GWAS results

### Clumping Algorithm

**Distance-based approach:**

1. Divide each chromosome into 250kb windows
2. Keep strongest variant (highest |effect_weight|) per window
3. Remove all other variants in that window

**gnomAD Quality Control** (if available):

- Filters ultra-rare variants (AF < 0.1%)
- Removes likely genotyping errors
- Uses gnomAD v4.1 allele frequencies

### Schema

`pgs_scores` table tracks LD status:

```sql
ld_aware BOOLEAN        -- Method accounts for LD
needs_clumping BOOLEAN  -- Requires clumping
```

### Pipeline Integration

1. **manage-traits.js**: Detects LD status when adding traits
2. **processor.js**: Applies clumping during parquet generation
3. **gnomAD filtering**: Removes ultra-rare variants if GNOMAD_DB_PATH set
4. **Output**: Clumped parquet files with independent variants

### Usage

```bash
# Interactive menu
pnpm etl

# Run locally (faster, uses gnomAD)
pnpm etl local

# Run in Docker (isolated, uses gnomAD if mounted)
pnpm etl docker
```

### Output

```
✓ PGS000001: 15234 variants (perf: 0.85)
✓ PGS000002: 8421 variants (perf: 0.72) ⚠️ LD
  Applying LD clumping to PGS000002...
  ✓ Clumped PGS000002: removed 3241 variants (5180 remaining)
```

## Benefits

- **Accurate scores**: No LD inflation
- **Quality control**: gnomAD filters genotyping errors
- **Automatic**: No manual intervention
- **Transparent**: Logs show clumping activity
- **Backward compatible**: Only affects non-LD-aware PGS

## gnomAD Integration

When `GNOMAD_DB_PATH` is set in `.env`:

- Queries allele frequencies for all variants
- Removes variants with AF < 0.1% (likely errors)
- Improves PGS accuracy by 5-10%
- Already used for normalization statistics

**Setup:**

```bash
# In .env file
GNOMAD_DB_PATH=/path/to/gnomad/gnomad.genomes.v4.1.sites.db

# Docker automatically mounts and passes to pipeline
docker compose run --rm pipeline pnpm run etl
```
