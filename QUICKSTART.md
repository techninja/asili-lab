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

### 4. Calculate reference statistics

Computes population normalization parameters (mean/SD) for each PGS score. Uses gnomAD data if available, otherwise falls back to theoretical defaults.

```bash
pnpm pgs refstats batch
```

This writes `norm_mean` and `norm_sd` to the `pgs_scores` table, which the scoring engine uses to z-score normalize results.

### 5. Run the ETL pipeline

Builds parquet files and the frontend manifest from the processed trait data.

```bash
pnpm etl local
```

This generates:
- `data_out/packs/*.parquet` — one file per trait
- `data_out/trait_manifest.json` — frontend trait list (only includes traits with built parquet files)

### 6. Start the server

```bash
pnpm start
# Access at http://localhost:4242
```

## Tier System

Asili uses allowlists to control which traits are built and served. The default is `tier1_public` — safe, non-disease quantitative traits.

| Tier | Env Value | Traits | Description |
|---|---|---|---|
| Free Public | `tier1_public` | ~44 | Quantitative only, no disease risk |
| Researcher | `tier2_researcher` | All | Full catalog |
| Local/Docker | `local` | All | No filtering |

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
pnpm pgs refstats batch
pnpm etl local
```
