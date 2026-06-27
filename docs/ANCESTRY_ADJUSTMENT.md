# Ancestry Adjustment — Specification

## Problem

Polygenic scores are biased by population stratification. A raw PGS trained on European cohorts will systematically over/under-predict risk for non-European users because baseline allele frequencies differ across populations. The Asili pipeline must adjust for this to produce valid cross-ancestry results.

## Current State

### What exists today

1. **User-selected ancestry** — a `localStorage` setting in the browser app (`ancestry` key)
2. **Per-population norm params** — `pgs_norm_params.json` contains an optional `ancestry` field per PGS with population-specific `{m, s}` (mean/SD):
   ```json
   "PGS000001": {
     "m": 0.0042,
     "s": 0.0031,
     "n": 785,
     "ancestry": {
       "AFR": { "m": 0.0089, "s": 0.0028 },
       "EAS": { "m": 0.0012, "s": 0.0025 },
       "EUR": { "m": 0.0041, "s": 0.0030 }
     }
   }
   ```
3. **gnomAD-sourced AFs** — `generate-ancestry-norms.py` computes theoretical mean/SD per population (AFR, AMR, ASJ, EAS, FIN, MID, NFE, SAS) from gnomAD allele frequencies joined against trait packs
4. **Empirical norms** — `calc-pgs-refstats-empirical.py` scores 3,202 NYGC 1000 Genomes individuals to get empirical mean/SD, but currently produces a single global distribution (not stratified by population)
5. **Browser normalization** — `normalizer.js` swaps in ancestry-specific `m`/`s` when the user has selected an ancestry

### What's missing

- No automated ancestry inference from genotype data
- No PCA projection against a reference panel
- No regression residualization of raw scores against PCs
- Empirical norms are global (all 3,202 samples pooled), not per-superpopulation
- User must manually select ancestry — no guidance or validation

## Architecture

### Phase 1: Population-Stratified Empirical Norms (pipeline-side)

**Goal:** Compute per-superpopulation empirical mean/SD from the 1000 Genomes scoring that already runs.

The NYGC 30x dataset includes 3,202 individuals with known superpopulation labels (from the 1000 Genomes sample panel). The empirical scoring in `calc-pgs-refstats-empirical.py` already scores all of them — it just pools the results.

#### Changes

1. **Load sample→superpopulation mapping** from `data_out/1kg_sample_panel.tsv` (already downloaded by `extract-1kg-ancestry-af.py`)
2. **Partition scores by superpopulation** before computing mean/SD:
   ```python
   # After scoring all chromosomes, pgs_scores[pgs_id] is shape (3202,)
   # sample_names[i] → sample_pop[sample_names[i]] → superpopulation
   for pop in ["AFR", "AMR", "EAS", "EUR", "SAS"]:
       mask = np.array([sample_pop.get(s) == pop for s in sample_names])
       pop_scores = pgs_scores[pgs_id][mask]
       pop_mean = float(np.mean(pop_scores))
       pop_sd = float(np.std(pop_scores))
   ```
3. **Write per-population norms** into the `ancestry` field of `pgs_norm_params.json`
4. **Replace theoretical gnomAD norms** — empirical per-population norms from actual scored individuals are strictly more accurate than theoretical E[PGS] = Σ(w × 2 × AF) which assumes variant independence

#### Superpopulation mapping

| Code | Label | N (NYGC 30x) | Notes |
|------|-------|--------------|-------|
| AFR  | African | ~893 | Largest group |
| AMR  | Admixed American | ~490 | High admixture |
| EAS  | East Asian | ~585 | |
| EUR  | European | ~741 | Closest to most GWAS training |
| SAS  | South Asian | ~493 | |

Minimum N ≈ 490 (AMR) — sufficient for stable mean/SD estimates.

#### Validation

- Per-population SD should be smaller than global SD (removing between-population variance)
- EUR mean should be close to global mean (most GWAS are EUR-trained)
- AFR SD may be larger (higher genetic diversity)

---

### Phase 2: Automated Ancestry Inference (browser-side)

**Goal:** Infer the user's ancestry from their genotype data without requiring manual selection.

#### Approach: Lightweight SNP-based classifier

Full PCA against 1000 Genomes requires loading a reference genotype matrix — too heavy for browser. Instead, use a pre-trained classifier on a small set of ancestry-informative markers (AIMs).

1. **Select ~2,000 AIMs** with maximum Fst between superpopulations (from 1000 Genomes Phase 3)
2. **Train a simple model** (e.g., logistic regression or nearest-centroid) on 1000 Genomes individuals using only these AIMs
3. **Export model weights** as a small JSON (~50KB)
4. **Score in browser** — after DNA upload, extract the user's genotypes at AIM positions, apply the model, output superpopulation probabilities

#### Output format

```json
{
  "inferred": "EUR",
  "probabilities": {
    "AFR": 0.02,
    "AMR": 0.08,
    "EAS": 0.01,
    "EUR": 0.85,
    "SAS": 0.04
  },
  "admixed": false,
  "confidence": "high"
}
```

#### Admixture handling

If no single population exceeds 70% probability, flag as `admixed: true`. For admixed individuals, use a weighted combination of population norms:

```
adjusted_mean = Σ(prob_pop × mean_pop)
adjusted_sd = √(Σ(prob_pop × sd_pop²))
```

This avoids forcing admixed users into a single reference bucket.

#### Privacy

- Model weights are static — no user data leaves the browser
- Ancestry inference runs client-side only
- Results stored in IndexedDB alongside other individual metadata
- User can override inferred ancestry manually

---

### Phase 3: PCA Projection (optional, future)

**Goal:** Full PCA-based ancestry adjustment for maximum accuracy.

This is the gold standard described in the Gemini review (Section 7.2) but requires significant infrastructure:

1. **Pre-compute PCA loadings** from 1000 Genomes on ~100K LD-pruned SNPs
2. **Ship loadings** (~20MB compressed) as a downloadable asset
3. **Project user genotypes** onto the first 10 PCs in-browser
4. **Regress raw PGS against PCs** using pre-computed regression coefficients:
   ```
   PGS_adjusted = PGS_raw - (β₀ + β₁×PC1 + β₂×PC2 + ... + β₁₀×PC10)
   ```

#### Why this is Phase 3

- Requires shipping ~20MB of PCA loadings per user session
- Regression coefficients must be pre-computed per PGS (thousands of regressions)
- Marginal improvement over Phase 2 for most users
- Most valuable for highly admixed individuals not well-served by discrete superpopulations

#### Pre-computation (pipeline-side)

For each PGS:
1. Score all 3,202 NYGC individuals (already done in Phase 1)
2. Compute top 10 PCs from the same individuals' genotypes at LD-pruned sites
3. Regress PGS scores against PCs: `lm(score ~ PC1 + PC2 + ... + PC10)`
4. Store regression coefficients per PGS

#### Browser-side

1. Load PCA loadings (cached after first download)
2. Project user's genotypes at the ~100K sites → 10 PC values
3. For each scored PGS, subtract the predicted ancestry component using stored coefficients
4. Normalize the residual against the residual distribution (which should be ancestry-independent)

---

## Implementation Priority

| Phase | Effort | Impact | Dependency |
|-------|--------|--------|------------|
| 1 | Low — modify existing empirical scoring script | High — replaces theoretical norms with real per-population distributions | None |
| 2 | Medium — train classifier, add browser inference | High — removes manual ancestry selection, handles admixture | Phase 1 (needs per-pop norms to use) |
| 3 | High — PCA infrastructure, large asset delivery | Moderate — incremental over Phase 2 for most users | Phase 1 + 2 |

## Files to Modify

### Phase 1
- `scripts/calc-pgs-refstats-empirical.py` — partition scores by superpopulation
- `scripts/export-norm-params.js` — ensure ancestry field is exported
- `data_out/1kg_sample_panel.tsv` — already exists, maps sample → pop

### Phase 2
- New: `scripts/train-ancestry-classifier.py` — train on 1000G AIMs
- New: `data_out/ancestry_model.json` — exported model weights
- New: `packages/core/src/ancestry-inference.js` — browser-side classifier
- Modify: `src/utils/score-trait.js` — auto-select ancestry from inference
- Modify: `src/store/AppState.js` — store inferred ancestry per individual

### Phase 3
- New: `scripts/compute-pca-loadings.py` — PCA on LD-pruned sites
- New: `scripts/compute-pgs-pc-regressions.py` — per-PGS regression
- New: `data_out/pca_loadings.parquet` — ~100K sites × 10 PCs
- New: `data_out/pgs_pc_coefficients.json` — regression betas per PGS
- New: `packages/core/src/pca-projection.js` — browser-side projection
- Modify: `packages/core/src/normalizer.js` — subtract PC-predicted component

## References

- Price et al. (2006) — PCA for population stratification
- Privé et al. (2020) — Efficient ancestry inference from SNP data
- Ruan et al. (2022) — PGS portability across ancestries
- PGS Catalog ancestry reporting standards
