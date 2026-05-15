# Asili Lab: Use Dosage R² (DR2) for Imputation Quality

## Problem

`imputation_quality` in the `.asili` unified files currently stores `max(GP)` — the maximum genotype probability from Beagle's three-class posterior. This is almost always ~1.0 (93% of variants are ≥0.99), which means the `sqrt(imputation_quality)` shrinkage applied during scoring does essentially nothing.

The result: imputed z-score SD is ~2.9 vs raw SD ~1.7 (target ~1.0). Pearson correlation between same-person raw and imputed scores is near zero (-0.09 to 0.30). Imputed scores are meaningless.

## Root Cause

`max(GP)` measures Beagle's confidence in the *called genotype class* (hom-ref, het, hom-alt). It does NOT measure how well the imputed dosage approximates the true dosage. A variant can have `max(GP) = 0.99` (very confident it's hom-ref) while the dosage is 0.02 — but the *true* dosage might be 0.0 or 1.0, and the uncertainty in that distinction is what matters for PGS scoring.

## Fix

Use Beagle's `DR2` (dosage R²) from the INFO field instead. DR2 estimates the squared correlation between the imputed dosage and the true dosage. It ranges from 0 to 1, with typical values of 0.3–0.9 for imputed variants. This is the correct metric for `sqrt(R²)` shrinkage in PGS scoring.

## What to Change

### File: `scripts/impute_user.py`

#### 1. `bcf_to_chr_parquet()` — extract DR2 from INFO field

Current bcftools query (line ~449):
```python
['bcftools', 'query', '-f', '%CHROM:%POS:%REF:%ALT\t[%DS]\t[%GP]\n', bcf_file],
```

Change to:
```python
['bcftools', 'query', '-f', '%CHROM:%POS:%REF:%ALT\t[%DS]\t[%GP]\t%INFO/DR2\n', bcf_file],
```

#### 2. Same function — DuckDB SQL that parses the TSV

Current SQL reads 3 TSV columns (column0=vid, column1=DS, column2=GP) and computes:
```sql
CAST(greatest(gp1, gp2, gp3) AS FLOAT) AS imputation_quality
```

Change to read 4 columns and use DR2:
```sql
-- column3 is DR2 from INFO field
CAST(column3 AS FLOAT) AS imputation_quality
```

Keep the `max(GP) >= 0.5` filter — that's still a good quality gate for excluding junk variants. But store DR2 as the quality metric.

The inner SELECT becomes something like:
```sql
SELECT
    column0 AS vid,
    column1 AS ds,
    CAST(split_part(column2, ',', 1) AS DOUBLE) AS gp1,
    CAST(split_part(column2, ',', 2) AS DOUBLE) AS gp2,
    CAST(split_part(column2, ',', 3) AS DOUBLE) AS gp3,
    column3 AS dr2
FROM read_csv('{tsv_file}', sep='\t', header=false, all_varchar=true)
```

And the outer SELECT:
```sql
SELECT
    regexp_replace(vid, '^chr', '') AS variant_id,
    CAST(ds AS FLOAT) AS genotype_dosage,
    CAST(dr2 AS FLOAT) AS imputation_quality
FROM (...)
WHERE greatest(gp1, gp2, gp3) >= 0.5
```

#### 3. Genotyped variants keep `imputation_quality = 1.0`

No change needed — genotyped variants already get `1.0`, which is correct (they ARE the true dosage, R² = 1.0).

## After the Fix

Re-run imputation for all 3 individuals:
```bash
pnpm imputation impute   # select each individual
pnpm imputation export   # re-export .asili files
```

Then copy the new `.asili` files to `/home/techninja/web/` for smoke testing in the frontend.

## Expected Impact

With real DR2 values (typically 0.3–0.9), `sqrt(DR2)` will be 0.55–0.95, giving meaningful per-variant shrinkage. The `avgShrinkage` across all imputed variants should drop from ~0.995 to ~0.7–0.85, which will:

1. Compress imputed raw scores toward the mean
2. Cause the normalizer's `sd *= shrinkage²` to actually reduce the expected SD
3. Bring imputed z-score SD from ~2.9 down toward ~1.0
4. Improve raw↔imputed correlation from near-zero to something meaningful

## Validation

After re-imputation, run the score diagnostic in the browser console (`/home/techninja/web/score-diagnostic.js`). Success criteria:
- Imputed z-score SD < 2.0 (ideally ~1.0–1.5)
- Same-person Pearson r > 0.3 (ideally > 0.5)
- Direction agreement > 75%
- Fewer than 5% of scores hitting the ±4 clamp
