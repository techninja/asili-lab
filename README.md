<p align="center">
  <img src="assets/logo.svg" alt="Asili" width="300">
</p>

<p align="center">
  <em>Swahili for "Root"</em> — Privacy-first polygenic risk score analysis.<br>
  All processing happens on your device.
</p>

<p align="center">
  <a href="https://asili.dev">Website</a> ·
  <a href="https://app.asili.dev">Launch App (coming soon)</a> ·
  <a href="https://github.com/techninja/asili-lab/tree/main/docs">Documentation</a>
</p>

---

## ⚗️ This is Asili Lab

This repository is the **experimental research workspace** where Asili's genomic scoring pipeline was developed and validated. It contains the ETL pipeline, imputation scripts, CLI scoring tools, and the data processing infrastructure that powers Asili.

**Looking for the app?** The production application is being rebuilt from spec in a separate repository and will be live at [app.asili.dev](https://app.asili.dev) soon. Until then, this repo serves as the reference implementation.

## What Was Proven Here

- **Allele-aware variant matching** — deterministic `allele_key` hashing eliminates multiallelic cross-product errors ([docs/ALLELE_KEY.md](docs/ALLELE_KEY.md))
- **TOPMed normalization** — 93.1% average AF coverage across 5,155 PGS scores ([docs/PGS_NORMALIZATION.md](docs/PGS_NORMALIZATION.md))
- **Quality score ranking** — validated PGS reliably outrank unvalidated ones ([docs/PGS_QUALITY_SCORE.md](docs/PGS_QUALITY_SCORE.md))
- **Full imputation pipeline** — Eagle2 phasing + Beagle 5.4 with TOPMed panel, 60-80% coverage ([docs/IMPUTATION.md](docs/IMPUTATION.md))
- **3 individuals × 647 traits** scored and validated with the corrected pipeline

## What's Here

```
asili-lab/
├── packages/
│   ├── core/             # Shared genomic processing library
│   └── pipeline/         # Data ETL pipeline (PGS Catalog → Parquet)
├── scripts/              # CLI tools (scoring, ETL, imputation, refstats)
├── apps/
│   ├── web/              # Experimental browser SPA (being rewritten)
│   └── calc/             # Calculation server for hybrid mode
├── docs/                 # Architecture and algorithm documentation
├── data_out/             # Generated Parquet files (gitignored)
└── cache/                # PGS Catalog cache (gitignored)
```

## Pipeline Usage

```bash
# Install dependencies
pnpm install

# Run ETL pipeline (builds trait packs from PGS Catalog)
pnpm etl

# Run imputation for a user
pnpm imputation impute

# Calculate scores
pnpm scores calc

# Analyze results
pnpm scores analyze
```

See [QUICKSTART.md](QUICKSTART.md) for full setup from a fresh clone.

## Documentation

| Document                                                  | Description                                       |
| --------------------------------------------------------- | ------------------------------------------------- |
| [APP_SPEC_V1.md](docs/APP_SPEC_V1.md)                     | Complete v1.0 application specification           |
| [SCORING_PIPELINE.md](docs/SCORING_PIPELINE.md)           | The proven scoring algorithm flow                 |
| [DATA_CONTRACTS.md](docs/DATA_CONTRACTS.md)               | Parquet schemas, manifest format, result shapes   |
| [ALLELE_KEY.md](docs/ALLELE_KEY.md)                       | Deterministic allele hashing for variant matching |
| [PGS_QUALITY_SCORE.md](docs/PGS_QUALITY_SCORE.md)         | How PGS are ranked and selected                   |
| [PGS_NORMALIZATION.md](docs/PGS_NORMALIZATION.md)         | TOPMed-derived z-score normalization              |
| [TIER_ARCHITECTURE.md](docs/TIER_ARCHITECTURE.md)         | Business model and deployment tiers               |
| [CLOUD_IMPUTATION_TODO.md](docs/CLOUD_IMPUTATION_TODO.md) | Paid imputation service plan                      |

## Privacy

Asili is designed with privacy as the foundational principle:

- **No Data Collection**: We never see, store, or transmit your genomic data
- **Local Processing**: All analysis happens on your own hardware
- **Open Source**: Full transparency in how your data is processed
- **User Control**: You own and control all data and results

Your DNA data is yours alone. Asili simply provides the tools to analyze it privately.

## License

AGPLv3 — See [LICENSE](LICENSE) for details.

- ✅ Use freely for personal or commercial purposes
- ✅ Modify and improve the code
- ✅ Run it as a service for others
- ❌ Create a proprietary closed-source version
- ❌ Hide your modifications from users
