# ETL Performance Optimizations

## Summary of Changes

Optimized the Asili ETL pipeline for native execution on systems with 32GB RAM and multiple CPU cores. The previous implementation was designed for Docker with conservative memory limits (2GB) and sequential processing to avoid OOM kills.

## Key Optimizations

### 1. **Increased Memory Limits**

- **DuckDB Memory**: 2GB → 16GB (configurable via `DUCKDB_MEMORY_LIMIT`)
- **DuckDB Threads**: auto → 8 threads (configurable via `DUCKDB_THREADS`)
- Allows DuckDB to use more RAM for sorting, joining, and aggregation operations

### 2. **Larger Batch Sizes**

- Small datasets (< 40 PGS): 20k → 150k variants per batch
- Medium datasets (40-60 PGS): 15k → 100k variants per batch
- Large datasets (60-80 PGS): 12k → 75k variants per batch
- Huge datasets (> 80 PGS): 10k → 50k variants per batch
- Reduces number of intermediate files and merge operations

### 3. **Parallel Batch Processing**

- Sequential → Parallel execution (default: 4 concurrent batches)
- Configurable via `MAX_PARALLEL_BATCHES` environment variable
- Automatically scales based on CPU count if not specified
- Proper Promise tracking to avoid race conditions

### 4. **Parallel File Downloads**

- Sequential → Parallel downloads in batches of 10
- Speeds up the initial file analysis phase
- Respects API rate limits by batching requests

### 5. **Parallel Parquet Merge**

- New `merge_parquet_parallel.py` script
- Uses ThreadPoolExecutor for concurrent I/O operations
- Reads multiple parquet files simultaneously
- Scales workers based on CPU count (up to file count)

### 6. **Environment Configuration**

- Added performance settings to `.env` file
- ETL runner now loads and displays these settings
- Easy to adjust for different hardware configurations

## Configuration

Edit `.env` file:

```bash
# Performance Settings (optimized for 32GB RAM)
DUCKDB_MEMORY_LIMIT=16GB      # Adjust based on available RAM
DUCKDB_THREADS=8              # Adjust based on CPU cores
MAX_PARALLEL_BATCHES=4        # Number of concurrent batch processes
```

### Recommended Settings by System

**16GB RAM System:**

```bash
DUCKDB_MEMORY_LIMIT=8GB
DUCKDB_THREADS=4
MAX_PARALLEL_BATCHES=2
```

**32GB RAM System (your setup):**

```bash
DUCKDB_MEMORY_LIMIT=16GB
DUCKDB_THREADS=8
MAX_PARALLEL_BATCHES=4
```

**64GB+ RAM System:**

```bash
DUCKDB_MEMORY_LIMIT=32GB
DUCKDB_THREADS=16
MAX_PARALLEL_BATCHES=6
```

## Expected Performance Improvements

1. **Batch Processing**: 3-5x faster due to larger batches and parallel execution
2. **File Analysis**: 5-10x faster due to parallel downloads
3. **Parquet Merge**: 2-4x faster due to parallel I/O
4. **Overall Pipeline**: 3-6x faster end-to-end

## Usage

Run as before:

```bash
pnpm etl local
```

The runner will automatically:

- Load performance settings from `.env`
- Display configuration on startup
- Use optimized batch sizes and parallelism

## Monitoring

Watch for:

- **Memory usage**: Should now utilize more RAM (monitor with `htop`)
- **CPU usage**: Should see multiple cores active during batch processing
- **Disk I/O**: Parallel merge will increase I/O throughput

## Rollback

If you encounter issues, reduce settings in `.env`:

```bash
DUCKDB_MEMORY_LIMIT=4GB
DUCKDB_THREADS=2
MAX_PARALLEL_BATCHES=1
```

Or use the original conservative settings by removing these lines entirely (will use defaults).

## Files Modified

1. `packages/pipeline/lib/batched-processor.js` - Parallel batches, larger sizes, parallel downloads
2. `packages/pipeline/lib/processor-core.js` - Increased DuckDB memory/threads
3. `packages/pipeline/lib/processor.js` - Optimized DuckDB settings
4. `packages/pipeline/merge_parquet_parallel.py` - New parallel merge script
5. `scripts/etl-runner.js` - Load and display .env settings
6. `.env` - Added performance configuration
