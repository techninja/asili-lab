# Genomic Processor Refactor — Complete

## Summary

Refactored ~3800 lines of tangled PGS scoring code (4 processing paths, duplicated scoring loops,
diverged browser/server implementations) into a clean v2 architecture with a single scoring path.

**Before**: 9 files, 4 code paths, duplicated scoring loop, coverage-scaled normalization bug
**After**: 8 files, 1 code path, SQL pushdown scoring, correct normalization

## What Was Done

### Phase 0: Normalization Fix (calculator.js)
- Removed coverage-scaled `sd * coverage` / `mean * coverage` from finalize()
- Empirical stats used unscaled; coverage affects quality score only
- Added incompatible stats detection: when `|raw - mean| / sd > 20σ` at <80% coverage,
  falls back to theoretical normalization (catches partial-sum vs full-PGS mean mismatch)
- Best PGS fallback relaxed: picks best available even when all PGS have < 8 variants

**Impact** (3 individuals × 140 traits = 420 trait results, 7521 PGS calculations):
- Catastrophic z-scores (>100σ): 36 → 3 (92% reduction)
- Extreme z-scores (>10σ): 807 → 539 (33% reduction)
- Null best PGS: 21 → 0

### Phase 1: scorer.js + matcher.js
- Single scoring loop in `scorer.js` — variant accumulation exists exactly once
- `loadFromDB()` for SQL pushdown path (no per-variant JS loop)
- `score()` fallback for non-unified DNA sources
- `matcher.js` for position key extraction and allele dosage resolution

### Phase 2: DNA Source Interface
- `dna-source/interface.js` — DNASource contract
- `dna-source/unified.js` — DuckDB JOIN with `scoreInDB()` SQL pushdown + retry on serialization errors
- `dna-source/genotyped-only.js` — in-memory Map lookup
- `dna-source/hybrid.js` — genotyped Map + imputed Parquet

### Phase 3: DuckDB Adapters
- `adapters/duckdb-server.js` — Node DuckDB with 6GB memory limit, temp spill-to-disk, temp dir cleanup
- `adapters/duckdb-browser.js` — DuckDB WASM wrapper (not yet used in production)

### Files Deleted
| File | Lines | Reason |
|------|-------|--------|
| `genomic-processor/server.js` | 660 | Replaced by scorer.js + dna-source/* |
| `genomic-processor/browser.js` | 311 | Old browser processor, not used by hybrid server |
| `genomic-processor/shared-calculator.js` | 724 | Replaced by calculator.js (normalization fix) |
| `genomic-processor/streaming-utils.js` | 186 | StreamingProcessor/PGSAggregator absorbed into scorer.js |
| `genomic-processor/streaming-worker.js` | 90 | Unused |
| `genomic-processor/parallel-worker.js` | 85 | Unused |
| `genomic-processor/hybrid-variant-lookup.js` | 88 | Replaced by dna-source/hybrid.js |
| **Total removed** | **2144** | |

## Current Architecture

```
packages/core/src/genomic-processor/    (1168 lines)
├── calculator.js        (405)  # SharedRiskCalculator — normalization, quality scores, finalize
├── scorer.js            (209)  # PGSScorer — single scoring loop + loadFromDB
├── matcher.js            (50)  # Position key extraction, allele dosage resolution
├── index.js              (47)  # Factory: createDNASource() + exports
├── dna-source/
│   ├── interface.js      (34)  # DNASource contract
│   ├── unified.js       (152)  # DuckDB SQL pushdown (scoreInDB + retry)
│   ├── genotyped-only.js (73)  # In-memory Map lookup
│   └── hybrid.js         (71)  # Genotyped + imputed Parquet
└── adapters/
    ├── duckdb-server.js   (67)  # Node DuckDB adapter (6GB limit, temp cleanup)
    └── duckdb-browser.js  (60)  # DuckDB WASM adapter (future)
```

### Scoring Flow (hybrid server)
```
calc/server.js → calculateTraitRiskV2()
  1. DuckDBServerAdapter (reused across traits)
  2. createDNASource() → UnifiedDNASource
  3. PGSScorer.loadFromDB(dnaSource.scoreInDB(traitUrl))
     └── 3 DuckDB queries: aggregation, chr coverage, top variants
  4. scorer.finalize() → calculator.finalize()
  5. Store result
```

### Performance
- BMI (89M variants, 125 PGS): ~15s total (was ~260s)
- Typical trait: 5-12s
- 140 traits × 3 individuals: ~2 hours total, zero restarts
- DuckDB: 6GB memory limit + spill-to-disk, temp dir cleanup between traits

## Remaining Work

### TODO: Browser-only mode migration
`unified-processor-browser.js` still references deleted `BrowserGenomicProcessor`.
Browser-only mode is deprioritized — hybrid server path is the target for v1.
When ready, migrate to v2 scorer + duckdb-browser adapter.

### TODO: Extract storage init from unified-processor.js
`unified-processor.js` is kept only because `createServerProcessor()` bootstraps
storage, trait manifest, cache, and queue. The risk calculation path in it is dead.
Extract the init logic into a standalone module and delete the file.

### TODO: Improve gnomAD reference stats
- Remaining 539 extreme z-scores (>10σ) are mostly bad gnomAD stats
  (computed on wrong population or full PGS when we score a subset)
- Recompute gnomAD stats against parquet variants per-PGS
- Consider population-specific reference panels

### TODO: Universal worker + parallelism (Phase 5 from original spec)
- Not needed yet — DuckDB SQL pushdown is fast enough
- If needed: split trait parquet into N chunks, score in parallel workers, merge

### TODO: Shared storage schema (Phase 6 from original spec)
- Browser (IndexedDB) and server (DuckDB) storage managers have diverged
- Create shared schema definitions when browser mode is prioritized
