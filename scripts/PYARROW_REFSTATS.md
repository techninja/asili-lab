# PyArrow Refstats Calculator

Fast calculation of PGS reference statistics using DuckDB + PyArrow.

## Performance

**Achieved: 160,791 variants/sec** on 7.4M variant PGS (PGS002853)

Tested on:

- gnomAD v4.1 parquet (3.8GB, 759M variants)
- BMI trait pack (1.3GB, 109M variants across 117 PGS)
- Hardware: 8 threads, 32GB RAM

## Prerequisites

1. **gnomAD Parquet**: Convert SQLite to Parquet format

   ```bash
   # One-time conversion (requires asili-calc-refs project)
   cd /path/to/asili-calc-refs
   node orchestrator.js run convert
   ```

2. **Trait Packs**: Generate parquet files via ETL

   ```bash
   pnpm etl
   ```

3. **Python Dependencies**: Auto-installed on first run
   - duckdb==1.1.3
   - pyarrow==18.1.0

## Usage

```bash
# Interactive menu
pnpm pgs
# Select: Calculate reference statistics → Batch (all missing)

# Direct commands
pnpm pgs refstats batch  # Calculate all missing PGS
pnpm pgs refstats reset  # Reset all statistics

# Or use the script directly
node scripts/calc-pgs-refstats.js batch
node scripts/calc-pgs-refstats.js reset
```

## Graceful Interruption

Press Ctrl+C to cancel processing at any time. The Python runner will be terminated gracefully.

## Architecture

- **Python Script** (`calc-pgs-refstats.py`): Core DuckDB processing
- **Node Orchestrator** (`calc-pgs-refstats-pyarrow.js`): Manages venv, runs Python, imports results
- **Output**: `data_out/pgs_gnomad_stats.json` → imported to `trait_manifest.db`

## Files

- `requirements.txt` - Python dependencies
- `scripts/calc-pgs-refstats.py` - Main processor
- `scripts/calc-pgs-refstats-pyarrow.js` - Node orchestrator
- `scripts/benchmark-pgs.py` - Single PGS benchmark
- `scripts/benchmark-single.py` - Single pack benchmark

## Output Format

```json
{
  "PGS000001": {
    "trait_id": "EFO_0004340",
    "total_variants": 7446664,
    "found_in_gnomad": 197539,
    "coverage_pct": 2.65,
    "mean_af": 0.005287,
    "stddev_af": 0.052008
  }
}
```

## Benchmarking

Test specific PGS:

```bash
.venv/bin/python3 scripts/benchmark-pgs.py \
  /path/to/gnomad.parquet \
  data_out/packs/EFO_0004340_hg38.parquet \
  PGS002853
```

## Notes

- gnomAD parquet must exist at `/home/techninja/web/gnomad.genomes.v4.1.sites.parquet`
- Processing ~2400 PGS takes approximately 7-10 minutes
- Results automatically imported to `pgs_scores` table (norm_mean, norm_sd)
