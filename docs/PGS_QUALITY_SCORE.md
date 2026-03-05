# PGS Quality Score

## Overview

The PGS Quality Score is a unified metric (0-100) that ranks polygenic scores for each individual based on three factors:

1. **Performance (R²)** - How well the PGS predicts the trait
2. **Coverage** - Percentage of PGS variants found in the individual's DNA
3. **Confidence** - Reliability based on number of matched variants

## Formula

```
Quality Score = (R² × 50) + (Coverage × 30) + (Confidence × 20)
```

### Components

#### Performance (50% weight)
- R² value from PGS Catalog metadata (0-1)
- Measures how much trait variance the PGS explains
- Default: 0.05 (5%) if not available

#### Coverage (30% weight)
- `matchedVariants / totalVariants` (0-1)
- Higher coverage = more reliable individual prediction
- Capped at 1.0 (100%)

#### Confidence (20% weight)
- Based on absolute number of matched variants:
  - `< 8 variants`: 0.1 (insufficient data, 90% penalty)
  - `< 10 variants`: 0.5 (low confidence, 50% penalty)
  - `< 100 variants`: 0.8 (medium confidence, 20% penalty)
  - `≥ 100 variants`: 1.0 (high confidence, no penalty)

## Examples

### Example 1: High-quality PGS
- R² = 0.20 (20% trait variance explained)
- Coverage = 0.85 (85% of variants matched)
- Matched variants = 150 (high confidence)

```
Score = (0.20 × 50) + (0.85 × 30) + (1.0 × 20)
      = 10 + 25.5 + 20
      = 55.5
```

### Example 2: Low-quality PGS
- R² = 0.05 (5% trait variance explained)
- Coverage = 0.30 (30% of variants matched)
- Matched variants = 5 (insufficient data)

```
Score = (0.05 × 50) + (0.30 × 30) + (0.1 × 20)
      = 2.5 + 9 + 2
      = 13.5
```

### Example 3: Medium-quality PGS
- R² = 0.12 (12% trait variance explained)
- Coverage = 0.65 (65% of variants matched)
- Matched variants = 45 (medium confidence)

```
Score = (0.12 × 50) + (0.65 × 30) + (0.8 × 20)
      = 6 + 19.5 + 16
      = 41.5
```

## Usage

### Backend (shared-calculator.js)
The quality score is automatically calculated during `finalize()`:

```javascript
details.qualityScore = SharedRiskCalculator.calculatePGSQualityScore(
  details.matchedVariants,
  totalVariants,
  performanceWeight
);
```

### Frontend (trait-card.js)
PGS are sorted by quality score (highest first):

```javascript
.sort((a, b) => {
  const scoreA = pgsDetails?.[a[0]]?.qualityScore ?? 0;
  const scoreB = pgsDetails?.[b[0]]?.qualityScore ?? 0;
  return scoreB - scoreA; // Descending
});
```

The best PGS is selected as the one with the highest quality score (with sufficient data).

## Display

Quality scores are shown as green badges in the UI:
- **55+**: Excellent quality
- **40-54**: Good quality
- **25-39**: Fair quality
- **<25**: Poor quality

The score is displayed with the format: `[score]/100`

Example: `55` (shown as green badge)

## Benefits

1. **Unified Ranking**: Single metric combines all quality factors
2. **Individual-Specific**: Accounts for each person's variant coverage
3. **Transparent**: Simple formula that can be displayed to users
4. **Balanced**: Weights factors appropriately (performance > coverage > confidence)
5. **Penalizes Insufficient Data**: Heavily reduces score when <8 variants matched

## Implementation Notes

- Score is calculated in `SharedRiskCalculator.calculatePGSQualityScore()`
- Stored in `pgsDetails[pgsId].qualityScore`
- Used to determine `bestPGS` in finalize()
- Frontend sorts by this score (descending)
- Server DB sorts by `quality_score DESC` in queries
- Replaces previous `sort_order` field and ad-hoc sorting
