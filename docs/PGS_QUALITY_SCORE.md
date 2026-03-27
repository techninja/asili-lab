# Asili PGS Quality Score

## Overview

The quality score (0-100) ranks PGS results by combining **scientific validity**, **data reliability**, and **individual informativeness**. It determines which PGS is selected as "best" for a trait when multiple PGS are available.

The score lives in [`packages/core/src/genomic-processor/calculator.js`](../packages/core/src/genomic-processor/calculator.js) as `SharedRiskCalculator.calculatePGSQualityScore()`.

## Formula

```
Quality Score = (R² × 35 × CoveragePenalty)
             + (GenotypedRatio × 15)
             + (Coverage × 10)
             + (log₁₀(matched/8) × 10)
             + (Normalization × 10)
             + (Signal × 20)
```

## Components

### 1. Predictive Accuracy (R²) — 35% weight

R² from PGS Catalog validation studies, measuring variance explained. Sourced from `pgs_performance` table (raw R² and "PGS R² (no covariates)" metrics only — incremental R² excluded as not comparable).

Values >1 are treated as percentages and normalized to 0-1. Default 0.05 when no validation data exists.

**Coverage Penalty** (applied to R² only):

- **<5% coverage**: Severe — `(coverage/0.05)²`
- **5-20% coverage**: Moderate — `√(coverage/0.20)`
- **>20% coverage**: None

**Why R² is primary**: A PGS with R²=0.13 explains 2.6× more variance than R²=0.05. This is the single most important differentiator when comparing PGS for the same trait.

### 2. Data Reliability — 15% weight

Proportion of matched variants that are directly genotyped (not imputed).

Formula: `genotypedVariants / matchedVariants × 15`

- 95% genotyped → **14.3 pts**
- 50% genotyped → **7.5 pts**
- 1% genotyped → **0.15 pts**

**Why it matters**: Genotyped variants are direct measurements (0, 1, or 2 alleles). Imputed variants are statistical estimates with inherent uncertainty. The R² reported by PGS Catalog was validated on accurately genotyped/sequenced cohorts, not imputed data.

### 3. Coverage — 10% weight

Percentage of PGS variants found in user's DNA.

Formula: `min(matched/total, 1) × 10`

**Note**: `total` is the variant count from the parquet file (post-LD-clumping), not the PGS Catalog `variants_number` (pre-clumping). Some parquet files have duplicate entries from harmonization, which can push coverage above 100%.

### 4. Sample Size — 10% weight

Number of variants matched, log-scaled with diminishing returns.

Formula: `min(log₁₀(matched/8) / 3.1, 1) × 10`

The minimum threshold is 8 matched variants — below this, the PGS is marked `insufficientData` and excluded from best-PGS selection entirely.

### 5. Normalization — 10% weight

Whether population statistics (TOPMed mean/SD) exist for percentile calculation.

- Has empirical mean/SD (≥80% TOPMed AF coverage): **10 pts**
- Has partial mean/SD (5-80% coverage): **7 pts**
- Missing (calculator uses theoretical fallback): **5 pts**

### 6. Signal Strength — 20% weight

How informative the result is for this individual, based on absolute z-score.

Formula: `min(|z| / 3, 1) × 20`

**With >5σ penalty**: If `|z| > 5`, signal score is **0 points**. A z-score beyond 5σ almost certainly indicates incompatible normalization statistics (e.g., gnomAD stats computed on a different variant set than the parquet), not genuine extreme genetic risk. Zeroing the signal prevents bad-stats PGS from being boosted by their own broken z-scores.

| z-score | Signal pts | Interpretation      |
| ------- | ---------- | ------------------- |
| 0σ      | 0          | Average — no signal |
| 1σ      | 6.7        | Moderate            |
| 2σ      | 13.3       | Strong              |
| 3σ+     | 20         | Capped at maximum   |
| >5σ     | **0**      | Bad stats penalty — also excluded from trait z-score |

## Weight Summary

```
Scientific Validity (35%):
  R² × CoveragePenalty    35%   How well does this PGS predict the trait?

Data Quality (25%):
  Data Reliability         15%   Are we using real DNA or statistical estimates?
  Coverage                 10%   Do we have the variants the PGS needs?

Interpretability (20%):
  Sample Size              10%   Enough data points?
  Normalization            10%   Can we calculate percentiles?

Informativeness (20%):
  Signal Strength          20%   How much do we learn about this individual?
```

## Normalization: How Z-Scores Are Calculated

Z-scores convert raw PGS sums into population-relative measures.

### Normalization Source: TOPMed Allele Frequencies

Mean and SD are computed from the theoretical distribution using allele frequencies from the TOPMed imputation reference panel (~70M variants). See [PGS_NORMALIZATION.md](PGS_NORMALIZATION.md) for details.

PGS with <5% TOPMed AF coverage get NULL normalization — the calculator falls back to estimating SD from the sum of squared weights (assumes af=0.5).

### >5σ Exclusion from Trait Z-Score

PGS with |z| > 5 are:
1. Given **0 signal points** in the quality score (prevents bad-stats PGS from ranking high)
2. **Excluded from the weighted trait-level z-score** (prevents one broken PGS from dominating the user-facing result)

The per-PGS z-score is still stored for transparency.

### Normalization Decision Tree

```
Has empirical mean/SD in manifest?
├── YES: User coverage ≥ 5%?
│   ├── YES: naiveZ > 20 AND user coverage < 80%?
│   │   ├── YES → Incompatible stats, use theoretical
│   │   └── NO  → Use empirical stats unscaled
│   └── NO  → Use theoretical normalization
└── NO → Use theoretical normalization
         (mean=0, sd=√(Σw²×0.5))
```

## Real-World Example: BMI-Adjusted Waist-Hip Ratio (EFO_0007788)

From Ethan's data (unified parquet, 13.6M variants):

| PGS       | R²    | Coverage | Matched | Geno/Imp          | z-score | Quality  | Notes                                        |
| --------- | ----- | -------- | ------- | ----------------- | ------- | -------- | -------------------------------------------- |
| PGS003485 | 5.0%  | 101.1%   | 793,573 | 3,601g + 789,972i | -3.79   | **51.8** | Best — huge variant set, near-full coverage  |
| PGS005095 | 5.0%  | 36.4%    | 175     | 156g + 19i        | -1.06   | **40.1** | Small PGS, decent genotyped ratio            |
| PGS000299 | 1.95% | 31.8%    | 147     | 131g + 16i        | -21.68  | **31.6** | Bad gnomAD stats → >5σ penalty zeroes signal |
| PGS000843 | 5.0%  | 0%       | 0       | —                 | null    | **0**    | No matches at all                            |

**Old code** gave PGS000299 a z-score of 0.039 (looked normal) and quality of 31.57. The coverage scaling accidentally masked the incompatible stats. The new code exposes the truth (z=-21.68) and the >5σ penalty prevents it from ranking higher than it should.

## Design Decisions

- **R² sourced from `pgs_performance` table**, not the pre-computed `trait_pgs.performance_weight` column. Only raw R² and "PGS R² (no covariates)" metrics are used.
- **Genotyped ratio at 15%** (not higher) because imputed data still has value — TOPMed imputation at 74% coverage provides useful signal. But genotyped data is more trustworthy.
- **Signal strength is personalized**: Same PGS scores differently for different people. A z=2.5σ result is more actionable than z=0.1σ.
- **>5σ penalty**: Extreme z-scores are almost always bad normalization, not real signal. Zeroing signal prevents garbage-in-garbage-out from inflating quality scores.
- **Coverage penalty only applies to R²**: Low coverage degrades the validated predictive power, but doesn't affect other components.
- **No double-counting**: Genotyped ratio appears only in Data Reliability, not also inside the R² multiplier.
- **Parquet variant count is the canonical denominator**: The parquet file is what we actually score against. The PGS Catalog `variants_number` is irrelevant after LD clumping.

## Interpretation

| Score | Rating    | Characteristics                                         |
| ----- | --------- | ------------------------------------------------------- |
| 65+   | Excellent | High R², good coverage, strong signal, mostly genotyped |
| 55-65 | Good      | Decent R² and coverage, moderate signal                 |
| 40-55 | Moderate  | Low coverage OR mostly imputed OR weak signal           |
| 0-40  | Limited   | Very low coverage, missing data, or no validation       |

## Testing

Quality score logic is tested in [`packages/core/tests/calculator.test.js`](../packages/core/tests/calculator.test.js):

```bash
pnpm test core
```

Key test cases:

- Higher R² produces higher score
- Higher genotyped ratio produces higher score
- Coverage penalty below 5%
- > 5σ z-scores get 0 signal points
- Breakdown component scores sum to total
- No matched variants → score 0
