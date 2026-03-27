# Imputation System

Asili uses Eagle2 for pre-phasing and Beagle 5.4 for genotype imputation against the TOPMed reference panel, increasing variant coverage from ~600K (direct genotyping) to millions of variants.

## Quick Start

```bash
# 1. Setup Eagle2, Beagle, and TOPMed reference panel (~150GB)
pnpm imputation setup

# 2. One-time: convert panel to BCF for faster I/O
pnpm imputation optimize-panel

# 3. Impute user DNA
pnpm imputation impute
```

## TOPMed Reference Panel

- **Variants**: ~300 million
- **PGS Coverage**: 60-80% (~500K of 785K positions)
- **Download Size**: 150GB
- **Imputation Time**: 1-2 hours (parallelized)
- **Format**: VCF.gz (or BCF after `optimize-panel`)

## Commands

### Setup

```bash
# Download Eagle2 + Beagle + TOPMed
pnpm imputation setup

# Convert panel VCFs to BCF (faster Eagle2/Beagle reads)
pnpm imputation optimize-panel

# Verify panel and check coverage
pnpm imputation verify-panel
```

### Imputation

```bash
# Interactive mode - select individual
pnpm imputation impute

# Direct command
python3 scripts/impute_user.py \
  ./server-data/variants/1769791316003_Ethan.json \
  1769791316003_Ethan
```

### Utilities

```bash
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

1. **REF Allele Lookup**: Build chr:pos → REF map from TOPMed panel
2. **VCF Conversion**: JSON → VCF.gz with proper REF/ALT + strand flip detection
3. **Eagle2 Phasing**: Separate haplotype phasing optimized for sparse array data
4. **Beagle Imputation**: Impute missing variants using pre-phased haplotypes + TOPMed
5. **Quality Filtering**: Drop imputed variants with max(GP) < 0.5
6. **Parquet Export**: Convert to columnar format with imputation quality

Steps 3-5 run in parallel across chromosomes (2 concurrent by default).

### Output

- Imputed file: `server-data/imputed/{id}_{name}_imputed.parquet`
- Unified file: `server-data/unified/{id}_{name}.parquet`
- Format: `variant_id` (chr:pos:ref:alt), `genotype_dosage` (0.0-2.0), `imputation_quality` (max GP, 0.0-1.0)

## Performance

| Chromosome | Time  | Variants Out |
| ---------- | ----- | ------------ |
| chr1       | 8m    | ~40,000      |
| chr10      | 6m    | ~25,000      |
| chr22      | 4m    | ~10,000      |
| **Total**  | 1-2h  | ~500,000     |

With `optimize-panel` (BCF) and 2-chromosome parallelism, expect ~1 hour total.

## Storage Requirements

| Component         | Size  |
| ----------------- | ----- |
| TOPMed Panel      | 150GB |
| Temp Files (peak) | 15GB  |
| Output Parquet    | 2GB   |

## Environment Variables

```bash
# Reference panel directory
REF_PANEL_DIR=./cache/topmed_reference

# Beagle JAR location
BEAGLE_DIR=./tools/beagle

# Eagle2 binary and genetic map location
EAGLE_DIR=./tools/eagle

# Temp directory for large files
LARGE_TMP=/tmp

# Parallelism (auto-detected from CPU count)
IMPUTE_THREADS=8      # Total threads available
IMPUTE_PARALLEL=2     # Chromosomes processed concurrently
```

## Unified Parquet Scoring

After imputation, genotyped and imputed variants are merged into a single unified Parquet file per individual (`server-data/unified/{id}_{name}.parquet`). The scoring engine loads this once into DuckDB and JOINs against trait files using integer `chr:pos` columns.

Columns: `variant_id`, `genotype_dosage`, `imputed`, `imputation_quality`, `chr`, `pos`

Imputed variant contributions are weighted by √(imputation_quality) during scoring to reduce noise from low-confidence imputations.

## Troubleshooting

### Out of Memory

**Problem**: Beagle crashes with OOM error

**Solution**: Reduce parallelism or memory in environment:

```bash
export IMPUTE_PARALLEL=1  # Single chromosome at a time
```

### Disk Space

**Problem**: Not enough space for TOPMed

**Solution**: Use external drive

```bash
export REF_PANEL_DIR=/mnt/external/topmed_reference
pnpm imputation setup
```

### Download Interrupted

**Problem**: TOPMed download failed mid-way

**Solution**: Resume (script auto-skips existing files)

```bash
pnpm imputation setup
```

## Technical Details

### Eagle2 Pre-Phasing

Eagle2 is specifically optimized for phasing sparse array data against a reference panel. Separate phasing produces better haplotype estimates than Beagle's built-in phasing, especially for consumer arrays with ~600K variants.

```bash
eagle \
  --vcfTarget user_chr1.vcf.gz \
  --vcfRef chr1.topmed.bcf \
  --geneticMapFile genetic_map_hg38_withX.txt.gz \
  --chrom chr1 \
  --outPrefix user_chr1_phased \
  --numThreads 4 \
  --vcfOutFormat z
```

The phased output is then passed directly to Beagle, which skips its own phasing step and only performs imputation. This two-step approach (Eagle2 → Beagle) follows the architecture used by the Michigan Imputation Server and weIMPUTE.

If Eagle2 is not installed, the pipeline falls back to Beagle's built-in phasing.

### Beagle Parameters

```bash
java -Xmx8g -jar beagle.jar \
  gt=user_chr1_phased.vcf.gz \
  ref=chr1.topmed.bcf \
  out=imputed \
  impute=true \
  gp=true \
  ap=true \
  ne=20000 \
  err=0.0005 \
  seed=42 \
  nthreads=4
```

- `impute=true`: Enable imputation
- `gp=true`: Output genotype probabilities
- `ap=true`: Output allele probabilities for better dosage
- `ne=20000`: Effective population size tuned for sparse consumer arrays
- `err=0.0005`: Genotyping error rate for consumer arrays
- `seed=42`: Reproducible results

### Dosage Calculation

Beagle outputs GP (genotype probabilities) per variant. The max GP value
indicates how confident Beagle is in the called genotype:

```
Genotyped (from array):
GT=0/0 → DS=0.0, maxGP=1.0  (homozygous reference)
GT=0/1 → DS=1.0, maxGP=1.0  (heterozygous)
GT=1/1 → DS=2.0, maxGP=1.0  (homozygous alternate)

Imputed:
GT=0/1 → DS=0.85, maxGP=0.93  (high confidence)
GT=1/1 → DS=1.95, maxGP=0.97  (high confidence)
GT=0/0 → DS=0.12, maxGP=0.88  (moderate confidence)
GT=0/0 → DS=0.50, maxGP=0.40  (dropped: maxGP < 0.5)
```

Note: Beagle also outputs INFO/DR2 but this metric is unreliable for
single-sample imputation (N=1). The pipeline uses max(GP) instead.

During PGS scoring, imputed variant contributions are weighted by √(maxGP):

```
contribution = effect_weight × dosage × √(maxGP)
```

### Position-Based Matching

PGS variants may have different REF/ALT alleles than the user's data:

```
PGS:     chr10:100002628:A:G
Imputed: chr10:100002628:G:A

Solution: Match by chr:pos, flip dosage if alleles are swapped
dosage_flipped = 2.0 - dosage_original
```

### Strand Flip Handling

Consumer arrays (especially AncestryDNA) may report alleles on the opposite strand:

```
Reference: chr1:12345 REF=A
User data: chr1:12345 allele1=T allele2=T

Neither allele matches REF (A), but complement(T)=A matches.
Solution: Flip to complement strand → allele1=A, allele2=A → GT=0/0
```

This is handled during VCF conversion using a REF allele lookup built from the TOPMed panel.

## Alternative: Michigan Imputation Server

For users without local compute:

1. Visit https://imputationserver.sph.umich.edu/
2. Upload VCF (from step 2 of pipeline)
3. Select "TOPMed r2" panel
4. Download results
5. Convert to Parquet format

**Note**: Requires uploading genetic data to third party.

## References

- Beagle 5.4: https://faculty.washington.edu/browning/beagle/beagle.html
- Eagle2: https://alkesgroup.broadinstitute.org/Eagle/
- TOPMed: https://www.nhlbiwgs.org/
- PGS Catalog: https://www.pgscatalog.org/
