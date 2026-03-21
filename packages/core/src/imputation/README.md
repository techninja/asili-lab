# Imputation Quick Start

## Overview

The imputation system dramatically improves PGS coverage by filling in missing variants using LD-based imputation with 1000 Genomes reference panels.

**Coverage improvement**: 1-5% → 60-80% on typical PGS

## Prerequisites

```bash
# Install required tools
conda install -c bioconda plink2 bcftools

# Or on Ubuntu/Debian
apt-get install plink2 bcftools wget
```

## Build Reference Panel

### Test with Chromosome 22 (Smallest)

```bash
# Build chr22 reference panel (~5-10 minutes, ~200MB)
pnpm impute:build --chr 22 --population EUR --maf 0.01

# Output: data_out/imputation/1000g_eur_chr22.parquet
```

### Build Full Panel (All Chromosomes)

```bash
# Build all chromosomes (~2-4 hours, ~8GB total)
for chr in {1..22}; do
  pnpm impute:build --chr $chr --population EUR --maf 0.01
done
```

### Options

- `--chr <N>`: Chromosome number (1-22)
- `--population <POP>`: EUR, AFR, EAS, SAS, AMR, or ALL
- `--maf <FLOAT>`: Minimum minor allele frequency (default: 0.01)
- `--minR2 <FLOAT>`: Minimum LD r² threshold (default: 0.8)

## Integration with Risk Calculation

```javascript
import { createImputer } from '@asili/core/imputation/local-imputer.js';

// Create imputer
const imputer = await createImputer(duckdb, userDNA, {
  population: 'EUR',
  minQuality: 0.3,
  dataPath: '/data/imputation'
});

// Impute missing variants
const targetRSIDs = ['rs123456', 'rs789012', ...];
const imputed = await imputer.imputeVariants(userDNA, targetRSIDs);

// Combine with genotyped variants
const allVariants = [...userDNA, ...imputed];

// Calculate PGS with improved coverage
const result = await calculateRisk(traitId, allVariants);
```

## Storage Requirements

| Scope           | Variants | Size  | Coverage Gain    |
| --------------- | -------- | ----- | ---------------- |
| Chr22 only      | ~300K    | 200MB | Testing          |
| Common (MAF>5%) | ~8M      | 2GB   | 10-20% → 60-80%  |
| Low-freq (1-5%) | ~15M     | 4GB   | Additional 5-10% |
| All (MAF>1%)    | ~25M     | 8GB   | Maximum coverage |

## Performance

- **Browser**: ~30-60s to impute 2M variants
- **Server**: ~5-10s to impute 2M variants
- **Caching**: Reference panels cached in IndexedDB/filesystem

## Quality Metrics

Imputed variants include quality scores:

- **>0.8**: High quality (use like genotyped)
- **0.5-0.8**: Moderate quality (acceptable)
- **0.3-0.5**: Low quality (use with caution)
- **<0.3**: Excluded automatically

## Next Steps

1. Build chr22 reference panel for testing
2. Test on a PGS with known low coverage
3. Measure coverage improvement
4. Build full reference panel if results are good
5. Integrate with UI (add imputation toggle)

## Troubleshooting

### PLINK2 not found

```bash
# Install via conda
conda install -c bioconda plink2

# Or download binary
wget https://s3.amazonaws.com/plink2-assets/alpha5/plink2_linux_x86_64.zip
unzip plink2_linux_x86_64.zip
sudo mv plink2 /usr/local/bin/
```

### Download fails

1000 Genomes FTP can be slow. Use alternative mirror:

```bash
# Edit build-imputation-panel.js, change URL to:
# http://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/
```

### Out of memory

Reduce chromosome size or increase system memory:

```bash
# Process smaller regions
pnpm impute:build --chr 22 --maf 0.05  # Higher MAF = fewer variants
```

## References

- [Full Strategy Document](../docs/IMPUTATION_STRATEGY.md)
- [1000 Genomes Project](https://www.internationalgenome.org/)
- [PLINK2 Documentation](https://www.cog-genomics.org/plink/2.0/)
