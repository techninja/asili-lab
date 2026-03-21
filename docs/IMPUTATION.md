# Imputation System

Asili uses Beagle 5.4 for genotype imputation to increase variant coverage from ~600K (direct genotyping) to millions of variants.

## Quick Start

```bash
# 1. Setup Beagle and 1000 Genomes (9GB, 2.2% PGS coverage)
pnpm imputation setup

# 2. (Optional) Upgrade to TOPMed (150GB, 60-80% PGS coverage)
pnpm imputation setup-topmed

# 3. Extract PGS positions from trait files
pnpm imputation extract-positions

# 4. Impute user DNA
pnpm imputation impute
```

## Reference Panels

### 1000 Genomes Phase 3 (Default)

- **Variants**: ~80 million
- **PGS Coverage**: 2.2% (~17K of 785K positions)
- **Download Size**: 9GB
- **Imputation Time**: 45-60 minutes
- **Use Case**: Quick testing, limited storage

### TOPMed Freeze 8 (Recommended)

- **Variants**: ~300 million
- **PGS Coverage**: 60-80% (~500K of 785K positions)
- **Download Size**: 150GB
- **Imputation Time**: 2-3 hours
- **Use Case**: Production, accurate risk scores

## Commands

### Setup

```bash
# Download Beagle + 1000 Genomes
pnpm imputation setup

# Download TOPMed panel (recommended for production)
pnpm imputation setup-topmed

# Verify panels and check coverage
pnpm imputation verify-panel
```

### Imputation

```bash
# Interactive mode - select individual and panel
pnpm imputation impute

# Direct command (auto-detects best panel)
python3 scripts/impute_user.py \
  ./server-data/variants/1769791316003_Ethan.json \
  1769791316003_Ethan
```

### Utilities

```bash
# Extract PGS positions for filtering
pnpm imputation extract-positions

# Check system status
pnpm imputation status

# Clean imputation data
pnpm imputation clean
```

## Architecture

### Input

- User DNA file: `server-data/variants/{id}_{name}.json`
- Format: 23andMe, AncestryDNA, etc. (~600K variants)

### Processing Pipeline

1. **VCF Conversion**: JSON → VCF.gz with proper genotypes
2. **Chromosome Split**: Extract per-chromosome variants
3. **Beagle Imputation**: Phase and impute using reference panel
4. **Position Filtering**: Keep only PGS-relevant positions
5. **Parquet Export**: Convert to efficient columnar format

### Output

- Imputed file: `server-data/imputed/{id}_{name}_imputed.parquet`
- Format: `variant_id` (chr:pos:ref:alt), `genotype_dosage` (0.0-2.0)

## Performance

### 1000 Genomes

| Chromosome | Time | Variants Out |
| ---------- | ---- | ------------ |
| chr1       | 3m   | ~1,200       |
| chr10      | 2m   | ~700         |
| chr22      | 1m   | ~300         |
| **Total**  | 45m  | ~17,000      |

### TOPMed

| Chromosome | Time | Variants Out |
| ---------- | ---- | ------------ |
| chr1       | 8m   | ~40,000      |
| chr10      | 6m   | ~25,000      |
| chr22      | 4m   | ~10,000      |
| **Total**  | 2.5h | ~500,000     |

## Storage Requirements

| Component         | 1000G | TOPMed |
| ----------------- | ----- | ------ |
| Reference Panel   | 9GB   | 150GB  |
| Temp Files (peak) | 5GB   | 15GB   |
| Output Parquet    | 64MB  | 2GB    |

## Environment Variables

```bash
# Reference panel directory
REF_PANEL_DIR=./cache/topmed_reference

# Panel type (auto-detects by default)
REF_PANEL_TYPE=auto  # Options: auto, 1000g, topmed

# Beagle JAR location
BEAGLE_DIR=./tools/beagle

# Temp directory for large files
LARGE_TMP=/tmp
```

## Hybrid Variant Lookup

After imputation, the calculation server uses a hybrid lookup system:

1. **Genotyped variants** (~600K): Loaded in memory
2. **Imputed variants** (~500K with TOPMed): Queried on-demand from Parquet
3. **Cache**: 50K most-recently-used imputed variants

This avoids JavaScript Map size limits (16.7M entries) while maintaining performance.

### Performance Metrics

```
Batch query: 782K positions → 26,844 variants in 30 seconds
Processing: 785K variants in 90 seconds (~600K variants/sec)
Cache hit rate: 85-95% after warmup
```

## Troubleshooting

### Low Coverage

**Problem**: Only 2.2% of PGS variants found

**Solution**: Upgrade to TOPMed panel

```bash
pnpm imputation setup-topmed
pnpm imputation impute  # Re-run for user
```

### Out of Memory

**Problem**: Beagle crashes with OOM error

**Solution**: Reduce memory allocation in `scripts/impute_user.py`:

```python
cmd = ['java', '-Xmx4g', '-jar', BEAGLE_JAR, ...]  # Change from 8g to 4g
```

### Disk Space

**Problem**: Not enough space for TOPMed

**Solution**: Use external drive

```bash
export REF_PANEL_DIR=/mnt/external/topmed_reference
pnpm imputation setup-topmed
```

### Download Interrupted

**Problem**: TOPMed download failed mid-way

**Solution**: Resume (script auto-skips existing files)

```bash
pnpm imputation setup-topmed
```

## Technical Details

### Beagle Parameters

```bash
java -Xmx8g -jar beagle.jar \
  gt=user.vcf.gz \
  ref=chr1.topmed.vcf.gz \
  out=imputed \
  impute=true \
  gp=true \
  nthreads=8
```

- `impute=true`: Enable imputation
- `gp=true`: Output genotype probabilities
- `nthreads=8`: Parallel processing

### Dosage Calculation

Beagle outputs dosage (DS) field: expected ALT allele count (0.0-2.0)

```
GT=0/0 → DS=0.0 (homozygous reference)
GT=0/1 → DS=1.0 (heterozygous)
GT=1/1 → DS=2.0 (homozygous alternate)
GT=./. → DS=0.5-1.5 (imputed probability)
```

### Position-Based Matching

PGS variants may have different REF/ALT alleles than reference panel:

```
PGS:     chr10:100002628:A:G
Imputed: chr10:100002628:G:A

Solution: Match by position, flip dosage if needed
dosage_flipped = 2.0 - dosage_original
```

## Alternative: Michigan Imputation Server

For users without local compute:

1. Visit https://imputationserver.sph.umich.edu/
2. Upload VCF (from step 1 of pipeline)
3. Select "TOPMed r2" panel
4. Download results
5. Convert to Parquet format

**Note**: Requires uploading genetic data to third party.

## References

- Beagle 5.4: https://faculty.washington.edu/browning/beagle/beagle.html
- TOPMed: https://www.nhlbiwgs.org/
- 1000 Genomes: https://www.internationalgenome.org/
- PGS Catalog: https://www.pgscatalog.org/
