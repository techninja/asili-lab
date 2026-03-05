# ETL Performance Quick Reference

## What Changed

✅ **5x larger batch sizes** - fewer intermediate files  
✅ **8x more memory** - 2GB → 16GB for DuckDB  
✅ **4x parallel batches** - concurrent processing  
✅ **10x parallel downloads** - faster file analysis  
✅ **Multi-threaded merge** - parallel I/O operations  

## Your Current Settings (.env)

```bash
DUCKDB_MEMORY_LIMIT=16GB      # 50% of your 32GB RAM
DUCKDB_THREADS=8              # Adjust to your CPU core count
MAX_PARALLEL_BATCHES=4        # 4 concurrent DuckDB processes
```

## Expected Results

**Before:** Sequential processing, 2GB RAM, small batches  
**After:** Parallel processing, 16GB RAM, large batches  

**Speed Improvement:** 3-6x faster overall

## Run It

```bash
pnpm etl local
```

You'll see:
```
⚙️  Performance Configuration:
   Memory Limit: 16GB
   Threads: 8
   Parallel Batches: 4
```

## Monitor Performance

```bash
# Watch CPU and memory usage
htop

# Watch disk I/O
iotop -o
```

You should now see:
- Multiple CPU cores active (not just 1-2)
- Higher memory usage (8-16GB instead of 2GB)
- Multiple DuckDB processes during batch phase

## Troubleshooting

**Out of Memory?**
```bash
# Reduce in .env
DUCKDB_MEMORY_LIMIT=8GB
MAX_PARALLEL_BATCHES=2
```

**CPU not saturated?**
```bash
# Increase in .env
DUCKDB_THREADS=16
MAX_PARALLEL_BATCHES=6
```

**Still slow?**
- Check disk I/O (SSD vs HDD makes huge difference)
- Ensure gnomAD is on fast storage
- Monitor network if downloading many files

## Architecture

```
Old: PGS1 → PGS2 → PGS3 → ... → Merge
     (sequential, 2GB each)

New: [PGS1, PGS2, PGS3, PGS4] → Batch1 ─┐
     [PGS5, PGS6, PGS7, PGS8] → Batch2 ─┤→ Parallel Merge
     [PGS9, PGS10, ...]       → Batch3 ─┤
     [...]                    → Batch4 ─┘
     (parallel, 16GB each, 4 concurrent)
```

## Files Changed

- `batched-processor.js` - Parallel execution
- `processor-core.js` - Memory limits
- `processor.js` - DuckDB settings
- `merge_parquet_parallel.py` - New parallel merge
- `etl-runner.js` - Load .env settings
- `.env` - Performance config
