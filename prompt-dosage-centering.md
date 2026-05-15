# Asili Lab: Implement Dosage Centering for Imputed Scoring

## Context

See `docs/IMPUTATION_SCORING_INVESTIGATION.md` for full background. The short version:

Imputed PGS scores are systematically biased — unrelated individuals have r=0.72 cross-correlation on imputed scores (should be <0.3). The root cause: imputed dosages are not centered by population allele frequency. Without centering, every individual accumulates the same `weight × 2×AF` constant across thousands of variants, drowning out individual genetic signal.

## The Fix

Change the scoring contribution for imputed variants from:

```
contribution = effect_weight × oriented_dosage × sqrt(DR2)
```

To:

```
contribution = effect_weight × (oriented_dosage - 2×AF) × sqrt(DR2)
```

Where `AF` is the TOPMed ALT allele frequency for that variant.

## Data Available

TOPMed allele frequencies are already on disk:
- **File**: `/media/techninja/gnomad/asili_cache/topmed_reference/allele_frequencies.tsv`
- **Format**: `variant_id\tAF` (tab-separated, no header)
- **Variant ID format**: `chr1:10390:CCCCTAA:C` (chr-prefixed, same as Beagle output)
- **Rows**: 70,768,225 (~70M)
- **Size**: 2.0 GB

The DNA `.asili` files use variant_ids WITHOUT chr prefix: `22:10519265:CA:C`

## Implementation Plan

### Option A: Bake AF into .asili exports (recommended)

Same pattern as DR2 baking (`scripts/dr2_calibration/bake_dr2.py`):

1. Split `allele_frequencies.tsv` into per-chromosome parquets keyed by `allele_key` (one-time, like DR2 splits)
2. During the bake step, look up AF for each variant and store it as a new column (or pre-compute `2×AF` and store that)
3. Scoring SQL becomes: `weight × (dosage - d.expected_dosage) × sqrt(d.imputation_quality)`

**Pros**: No runtime join, fast scoring, self-contained .asili files
**Cons**: Increases .asili file size slightly, requires re-bake

### Option B: Pre-center dosages during bake

Instead of storing AF and centering at score time, store `dosage - 2×AF` directly in `genotype_dosage`:

1. For imputed variants: `genotype_dosage = original_dosage - 2×AF`
2. For genotyped variants: leave as-is (they're already sparse and don't have the bias)
3. Scoring SQL stays unchanged: `weight × dosage × sqrt(imputation_quality)`

**Pros**: Zero scoring code changes, simplest integration
**Cons**: Centered dosages can be negative (confusing), breaks the "dosage = alt allele count" semantic, normalization params need adjustment

### Option C: Center at score time with AF lookup

Store AF in the .asili parquets, center in the SQL:

```sql
t.effect_weight
  * (CASE WHEN t.effect_allele = SPLIT_PART(d.variant_id,':',4)
          THEN d.genotype_dosage ELSE 2.0 - d.genotype_dosage END
     - CASE WHEN d.imputed THEN d.expected_dosage ELSE 0 END)
  * CASE WHEN d.imputed THEN SQRT(d.imputation_quality) ELSE 1.0 END
```

**Pros**: Clear semantics, dosage column stays meaningful, genotyped unaffected
**Cons**: Slightly more complex SQL

## Recommended Approach: Option C

Store `expected_dosage` (= `2×AF` oriented to match the effect allele) as a column in the .asili parquets. Subtract it only for imputed variants at score time. This keeps the data semantics clean and doesn't require normalization parameter changes for genotyped-only scoring.

### Steps

1. **Split AF file** into per-chr parquets with `allele_key` and `af` columns (same as DR2 split pattern)
2. **Update `bake_dr2.py`** (rename to `bake_imputation_metadata.py`?) to also look up AF and write an `expected_dosage` column = `2×AF` (oriented: if DNA ALT matches the higher-frequency allele, may need to use `2×(1-AF)` — think carefully about orientation here)
3. **Update scoring SQL** in `unified-source.js` to subtract `d.expected_dosage` for imputed variants
4. **Re-bake** all three individuals
5. **Re-score** and run diagnostic — target: cross-individual r < 0.3, same-person r > 0.5

### AF Orientation Detail

The AF in `allele_frequencies.tsv` is the **ALT allele frequency** (matching the VCF convention). The DNA `genotype_dosage` counts the ALT allele. So:

- If `effect_allele == DNA ALT`: oriented_dosage = dosage, expected = 2×AF
- If `effect_allele == DNA REF`: oriented_dosage = 2 - dosage, expected = 2×(1-AF)

Since we don't know the effect_allele at bake time (it varies per PGS), store raw `2×AF` and let the scoring SQL handle orientation:

```sql
-- expected_dosage stores 2×AF (ALT allele expected count)
-- If we flipped dosage (effect=REF), flip expected too
(oriented_dosage - CASE WHEN t.effect_allele = SPLIT_PART(d.variant_id,':',4)
                        THEN d.expected_dosage
                        ELSE 2.0 - d.expected_dosage END)
```

## Validation

After implementation, run `score-diagnostic.js` in the browser. Success criteria:
- Cross-individual r(imp, imp) < 0.3
- Same-person r(raw, imp) > 0.5
- Direction agreement > 85%
- Imputed z-score SD ≈ 1.0

## Notes

- The DR2 threshold can likely be relaxed back to 0.3 (or even removed) once centering is in place — centering eliminates the shared bias that made low-DR2 variants problematic
- Genotyped variants should NOT be centered (they don't have the population-frequency bias since they're directly observed)
- The `allele_frequencies.tsv` uses chr-prefixed variant IDs (`chr22:...`) while DNA uses unprefixed (`22:...`) — handle this during the split/lookup step
