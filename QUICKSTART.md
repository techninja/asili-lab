# Quickstart

Get Asili running from a fresh clone with no existing data.

## Prerequisites

- Node.js 22+
- pnpm (`npm install -g pnpm`)

## Setup

```bash
git clone https://github.com/your-org/asili.git
cd asili
pnpm install
```

## Build the Data Pipeline

### 1. Seed traits from PGS Catalog

Pulls all ~700 traits from the [PGS Catalog API](https://www.pgscatalog.org/rest/) into the local trait manifest database.

```bash
pnpm traits seed
```

This creates `data_out/trait_manifest.db` with trait names, descriptions, and categories. No PGS scores are downloaded yet.

### 2. Apply editorial overrides

Applies curated names, emojis, trait types, and descriptions from `trait_overrides.json`.

```bash
pnpm traits sync
```

### 3. Fetch PGS metadata

Downloads PGS score metadata, filters, and calculates normalization parameters for traits in the current tier.

```bash
pnpm traits refresh
```

By default this processes the **tier1_public** allowlist (~44 quantitative traits). To process all traits:

```bash
ASILI_TIER=local pnpm traits refresh
```

This is the slow step — each trait's PGS scores are fetched, filtered, and analyzed. Results are cached, so subsequent runs only process new traits.

### 4. Run the ETL pipeline

Builds parquet files and the frontend manifest from the processed trait data. Downloads harmonized GRCh38 scoring files from PGS Catalog.

```bash
pnpm etl local
```

This generates:

- `data_out/packs/*.parquet` — one file per trait (hg38 coordinates)
- `data_out/trait_manifest.json` — frontend trait list (only includes traits with built parquet files)

### 5. Calculate reference statistics

Computes empirical normalization parameters (mean/SD) for each PGS score by scoring
3,202 NYGC 30x 1000 Genomes individuals against all trait packs. First run downloads
the NYGC 30x phased VCFs (~26GB to `$NYGC_1KG_DIR`), extracts genotypes at pack
positions, then scores all individuals. All intermediate files are cached — safe to
interrupt and resume.

Automatically regenerates histogram density arrays after scoring.

```bash
# Full run (~6 hours first time, cached thereafter)
pnpm pgs refstats

# Test with one chromosome first (~5 min)
pnpm pgs refstats --chr 22

# Reset all norms + extracted genotypes
pnpm pgs refstats reset
```

This writes `norm_mean` and `norm_sd` to `trait_manifest.db` and updates
`data_out/pgs_norm_params.json` with empirical `m`, `s`, and `d` (density) arrays.

The export and distribution steps can also be run independently:

```bash
pnpm pgs export-norms          # manifest DB → JSON
pnpm pgs score-distribution     # regenerate density arrays
```

### 5b. Generate ancestry-specific norms (optional)

Computes per-population mean/SD using gnomAD v4.1 ancestry-stratified allele frequencies across 8 genetic ancestry groups (AFR, AMR, ASJ, EAS, FIN, MID, NFE, SAS). This enables ancestry-contextualized percentiles in the browser.

**One-time setup** — download gnomAD v4.1 per-chromosome sites VCFs (~300GB, cached on `$LARGE_TMP`):

```bash
bash scripts/extract-gnomad-ancestry-af.sh
```

This downloads VCFs to `$LARGE_TMP/gnomad_v4_sites/` and extracts ancestry AFs to `data_out/ancestry_af.tsv`. You can process one chromosome at a time: `bash scripts/extract-gnomad-ancestry-af.sh 22`

**Compute norms** (run in a separate terminal — takes ~10-30 min):

```bash
pnpm pgs ancestry-norms
```

Adds `ancestry: { AFR: {m, s}, NFE: {m, s}, ... }` to each PGS in `pgs_norm_params.json`.

### 6. Calculate scores

Run PGS calculations for all individuals and traits:

```bash
# All individuals × all traits
pnpm scores calc all

# Single trait, all individuals
pnpm scores calc EFO_0004340

# Interactive selection
pnpm scores calc
```

Results are stored in `data_out/risk_scores.db`.

### 7. Start the server

```bash
pnpm start
# Access at http://localhost:4242
```

## Tier System

Asili uses allowlists to control which traits are built and served. The default is `tier1_public` — safe, non-disease quantitative traits.

| Tier         | Env Value          | Traits | Description                        |
| ------------ | ------------------ | ------ | ---------------------------------- |
| Free Public  | `tier1_public`     | ~44    | Quantitative only, no disease risk |
| Researcher   | `tier2_researcher` | All    | Full catalog                       |
| Local/Docker | `local`            | All    | No filtering                       |

Set the tier via `ASILI_TIER` environment variable:

```bash
# Build everything locally
ASILI_TIER=local pnpm traits refresh
ASILI_TIER=local pnpm etl local
```

## Managing Traits

```bash
# Interactive trait manager
pnpm traits

# Add a single trait by ID
pnpm traits add EFO_0004340

# List traits in the database
pnpm traits list

# Analyze PGS quality for a trait
pnpm traits analyze MONDO:0005575
```

## Full Reset

To rebuild everything from scratch:

```bash
rm -rf data_out/
pnpm traits seed
pnpm traits sync
pnpm traits refresh
pnpm etl local
pnpm pgs refstats
bash scripts/extract-gnomad-ancestry-af.sh  # one-time gnomAD v4 download
pnpm pgs ancestry-norms
pnpm scores calc all
```
