# Asili Lab: Export PGS Detail JSON Files

## Goal

Create a new ETL script `packages/pipeline/export-pgs-detail.js` that generates **one JSON file per PGS** into `data_out/pgs_detail/`. The frontend lazy-loads a single file when the user opens a trait detail page. This runs at the end of the ETL pipeline alongside the existing manifest and norm params exports.

## Context

The frontend currently shows minimal PGS info (method, weight type, variant count) from `trait_manifest.json`. We want rich per-PGS detail: ancestry, sample sizes, evaluation cohorts, performance metrics, and publication info.

~1690 PGS IDs are in the current manifest. With full evaluation arrays, a single combined file would be too large. Individual files are ~1-3KB each and only fetched on demand.

All source data is already cached in the PGS API cache at `$CACHE_DIR` (default `/media/techninja/gnomad/asili_cache`).

## Data Sources

All data comes from the existing PGS Catalog API cache (`www.pgscatalog.org/`):

1. **Score metadata** — `rest_score_{PGS_ID}/no-params.json`
   - `data.publication` → `{id, title, doi, PMID, firstauthor, date_publication}`
   - `data.samples_variants` → array of `{sample_number, ancestry_broad, ancestry_country, cohorts}`
   - `data.samples_training` → same shape
   - `data.ancestry_distribution` → `{gwas: {dist, count}, eval: {dist, count}}`
   - `data.method_name`, `data.method_params`, `data.weight_type`, `data.variants_number`
   - `data.name` → PGS name/label
   - `data.license` → licensing text from PGS Catalog
   - `data.date_release` → when this PGS was released in the catalog

2. **Performance metrics** — `rest_performance_search/*.json` (hashed filenames, match by `data.url` containing the PGS ID)
   - `data.results[]` → each has:
     - `sampleset.samples[].{sample_number, ancestry_broad, cohorts[].{name_short, name_full}}`
     - `performance_metrics.{effect_sizes[], class_acc[], othermetrics[]}` — each metric has `{name_short, estimate, ci_lower, ci_upper}`
     - `publication.{id, firstauthor, date_publication}`

## Output

### Directory: `data_out/pgs_detail/`

One file per PGS: `data_out/pgs_detail/PGS000123.json`

```json
{
  "id": "PGS000123",
  "name": "PGS for LDL cholesterol",
  "method": "LDpred2 (bigsnpr)",
  "method_params": "p+t, p < 5e-8",
  "weight_type": "beta",
  "variants": 275831,
  "publication": {
    "id": "PGP000001",
    "title": "Prediction of breast cancer risk...",
    "doi": "10.1093/jnci/djv036",
    "pmid": 25855707,
    "author": "Mavaddat N",
    "date": "2015-04-08"
  },
  "ancestry": {
    "gwas": { "EUR": 100 },
    "eval": { "EUR": 80, "NR": 20 }
  },
  "samples": {
    "gwas": 22627,
    "training": 0,
    "eval": 50000
  },
  "evaluations": [
    {
      "ancestry": "European",
      "n": 50000,
      "cohort": "UKB",
      "metrics": [
        { "type": "R²", "value": 0.123, "ci": [0.11, 0.14] }
      ]
    }
  ],
  "license": "PGS obtained from the Catalog should be cited appropriately...",
  "date_release": "2019-10-14",
  "cache_date": "2026-01-05"
}
```

Each file is minified (no pretty-print). `evaluations` is the only array — one entry per sampleset evaluation.

### Build manifest: `data_out/pgs_detail/_build.json`

A single metadata file tracking provenance for the entire export:

```json
{
  "generated_at": "2026-05-01T12:00:00.000Z",
  "pgs_catalog_version": "2026-04-14",
  "source": "PGS Catalog (https://www.pgscatalog.org)",
  "license": "PGS Catalog data is licensed under CC BY 4.0. Individual scores may have additional licensing — see each PGS entry.",
  "terms": "https://www.ebi.ac.uk/about/terms-of-use/",
  "citation": "Lambert et al. (2021) The Polygenic Score Catalog. Nature Genetics. doi:10.1038/s41588-021-00783-5",
  "cache_dir": "/media/techninja/gnomad/asili_cache",
  "pgs_count": 1690,
  "skipped": 12
}
```

- `pgs_catalog_version`: derive from the most recent `date_release` seen across all score cache files
- `pgs_count` / `skipped`: actual counts from the export run

## Implementation

### Script: `packages/pipeline/export-pgs-detail.js`

Export a single async function `exportPgsDetail()`.

1. Load `data_out/trait_manifest.json` to get the set of PGS IDs (`Object.keys(manifest.pgs)`)
2. `mkdir -p data_out/pgs_detail/`
3. Build a performance lookup map once at startup:
   - Scan all files in `$CACHE_DIR/www.pgscatalog.org/rest_performance_search/*.json`
   - Read each, index by PGS ID from `data.results[].associated_pgs_id`
   - Store as `Map<pgsId, Array<perfResult>>`
4. For each PGS ID (bounded parallel, 20 concurrent file reads):
   - Read score cache: `$CACHE_DIR/www.pgscatalog.org/rest_score_{PGS_ID}/no-params.json`
   - Look up performance results from the map built in step 3
   - Build the output object per the shape above:
     - `samples.gwas`: sum `sample_number` from `samples_variants`
     - `samples.training`: sum `sample_number` from `samples_training`
     - `samples.eval`: sum all unique sampleset sample numbers from performance results
     - `evaluations`: one entry per performance result sampleset, collecting all metrics from `effect_sizes`, `class_acc`, and `othermetrics`
     - `ancestry.gwas` / `ancestry.eval`: from `ancestry_distribution.gwas.dist` / `eval.dist`
   - Write `data_out/pgs_detail/{PGS_ID}.json` (minified)
5. Skip PGS IDs with no cache data (log warning, don't fail)
6. Write `data_out/pgs_detail/_build.json` with provenance metadata:
   - `generated_at`: current ISO timestamp
   - `pgs_catalog_version`: max `date_release` seen across all scores
   - `source`, `license`, `terms`, `citation`: hardcoded PGS Catalog attribution
   - `cache_dir`: the cache path used
   - `pgs_count`: files written, `skipped`: files skipped
7. Log summary: `✓ Exported N PGS detail files (M skipped)`

### Integration into ETL

Add a call at the end of `etl_orchestrator.js`, after the existing exports:

```js
import { exportPgsDetail } from './export-pgs-detail.js';

// ... after exportTraitPacksAsili and scanParquetPGS ...
logger.log('📦 Exporting PGS detail metadata...');
await exportPgsDetail();
```

### Symlink for frontend

Symlink the directory into the frontend data dir (same pattern as other data files):

```bash
ln -sf /home/techninja/web/asili-lab/data_out/pgs_detail /home/techninja/web/asili/src/data/pgs_detail
```

`src/data/` is already gitignored. The frontend fetches `/data/pgs_detail/{PGS_ID}.json` on demand when a trait detail page opens.

## Notes

- Don't hit the API — everything comes from the file cache
- If a PGS has no performance cache, still write the file with `evaluations: []`
- The `ci` field in metrics should be `[ci_lower, ci_upper]` or omitted if both are null
- Metric `type` should use `name_short` from the API (e.g. "R²", "β", "AUC", "OR", "C-index")
- Keep the script under 150 lines
- Each per-PGS file includes `license` (from the API), `date_release` (when the PGS was published to the catalog), and `cache_date` (when our cache file was written, derived from `timestamp` in the cache JSON, formatted as YYYY-MM-DD) — this gives full traceability for how fresh the data is
- The `_build.json` file is the authoritative provenance record for the whole export and should be committed to git (unlike the per-PGS files which are gitignored with the rest of `data_out/`)
