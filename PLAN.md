## Development Plan: Local-Only DNA Research Tool

**Goal:** Build a privacy-first genomic research tool where user data never leaves their control, powered by a "Data Lakehouse" architecture using DuckDB WASM and Parquet.

**Core Philosophy:**

1. **Privacy:** User DNA is processed locally. It is never uploaded to external servers.
2. **Performance:** Range requests fetch only necessary genomic data.
3. **Flexibility:** Multiple deployment modes (browser-only, hybrid server, containerized).
4. **Open Source:** Engine is open, data curation can be monetized.

---

## ✅ Phase 1: The "Walking Skeleton" (COMPLETE)

**Objective:** Prove the end-to-end flow: Pipeline → CDN → Browser → DuckDB Query.

### Completed Features

- ✅ Monorepo structure with `apps/` and `packages/`
- ✅ Pipeline generates Parquet files with proper schema
- ✅ Docker Compose orchestration for local development
- ✅ DuckDB WASM integration in browser
- ✅ HTTP Range Request support for efficient data loading

---

## ✅ Phase 2: The Science Pipeline (COMPLETE)

**Objective:** Production-ready data generation with scientific accuracy.

### Completed Features

- ✅ Schema validation with proper chromosome handling
- ✅ Sorting optimization (chr → pos) for merge joins
- ✅ ZSTD compression for Parquet files
- ✅ Trait manifest generation with metadata
- ✅ PGS Catalog integration
- ✅ Batch processing for large datasets

---

## ✅ Phase 3: The User Experience (COMPLETE)

**Objective:** Seamless DNA file parsing and visualization.

### Completed Features

- ✅ Multi-format DNA file parsing (23andMe, AncestryDNA, MyHeritage)
- ✅ Web Worker-based parsing for non-blocking UI
- ✅ IndexedDB persistence for user data
- ✅ Individual/family member management
- ✅ Risk score visualization components
- ✅ Virtual scrolling for large trait lists
- ✅ Real-time progress tracking

---

## ✅ Phase 4: Hybrid Architecture (COMPLETE)

**Objective:** Support both browser-only and server-assisted processing.

### Completed Features

- ✅ Unified processor core (`@asili/core`)
- ✅ Browser-based processing with DuckDB WASM
- ✅ Server-side calculation server for heavy workloads
- ✅ WebSocket-based real-time updates
- ✅ Queue management for batch calculations
- ✅ Cache synchronization between browser and server
- ✅ Docker deployment options (static, hybrid, containerized)

---

## ✅ Phase 5: Production Features (COMPLETE)

**Objective:** Enterprise-ready features for reliability and scale.

### Completed Features

- ✅ Multi-individual support (family genomics)
- ✅ Persistent storage with SQLite + Parquet
- ✅ Cache export/import functionality
- ✅ Progress tracking and job management
- ✅ Error handling and recovery
- ✅ Memory-efficient processing
- ✅ Comprehensive logging and debugging

---

## 🚧 Phase 6: Open Source Preparation (IN PROGRESS)

**Objective:** Clean up codebase and prepare for public release.

### Tasks

#### Documentation

- [x] Update README.md with current architecture
- [ ] Create CONTRIBUTING.md with development guidelines
- [ ] Add LICENSE file (MIT recommended)
- [ ] Document API endpoints and WebSocket protocol
- [ ] Create deployment guides for each mode
- [ ] Add architecture diagrams
- [ ] Write user documentation for DNA upload and analysis

#### Code Cleanup

- [ ] Remove abandoned test files and mock data
- [ ] Consolidate Docker configurations
- [ ] Remove unused dependencies
- [ ] Add JSDoc comments to public APIs
- [ ] Standardize error messages
- [ ] Clean up console.log statements (use proper logging)

#### Testing

- [ ] Add unit tests for core genomic calculations
- [ ] Integration tests for DNA parsing
- [ ] End-to-end tests for risk calculation
- [ ] Performance benchmarks
- [ ] Browser compatibility tests

#### CI/CD

- [ ] GitHub Actions for linting and formatting
- [ ] Automated testing on PR
- [ ] Docker image builds and publishing
- [ ] Automated releases with semantic versioning

#### Security

- [ ] Security audit of data handling
- [ ] Input validation for DNA files
- [ ] Rate limiting for server endpoints
- [ ] CORS configuration review
- [ ] Dependency vulnerability scanning

---

## 🔬 Phase 6.5: Imputation System (NEW)

**Objective:** Dramatically improve PGS coverage through local LD-based imputation.

### Problem

DTC DNA tests (23andMe, AncestryDNA) only genotype ~600K variants, but PGS often require millions. This results in:

- 1-5% coverage on many PGS scores
- Unreliable risk calculations
- Quality penalties that can't compensate for missing data

### Solution

Pre-computed reference panels from 1000 Genomes / TOPMed that enable offline imputation:

- **Coverage improvement**: 1-5% → 60-80%
- **Privacy-preserving**: All processing local, no external APIs
- **Efficient**: Beagle 5.4 + TOPMed panel (150GB) or 1000G (9GB)
- **Quality-aware**: max(GP) filtering (≥ 0.5) and √(maxGP) scoring weights

### Implementation Status

- [x] Design imputation architecture (see `docs/IMPUTATION_ARCHITECTURE.md`)
- [x] Beagle 5.4 setup (`scripts/setup-beagle.sh`)
- [x] TOPMed panel download (`scripts/download_topmed_panel.sh`)
- [x] User imputation pipeline (`scripts/impute_user.py`)
- [x] REF allele lookup from reference panel (correct REF/ALT assignment)
- [x] Strand flip detection for consumer arrays (AncestryDNA, 23andMe)
- [x] max(GP) quality filtering and √(maxGP) scoring weights
- [x] Beagle tuning for consumer arrays (ne=20000, err=0.0005)
- [x] Unified parquet output (genotyped + imputed + imputation_quality)
- [ ] Add multi-ancestry support (AFR, EAS, SAS, AMR)
- [ ] Add UI toggle for imputation

### Usage

```bash
# Build reference panel for chromosome 22 (testing)
pnpm impute:build --chr 22 --population EUR --maf 0.01

# Build full reference panel (all chromosomes)
for chr in {1..22}; do
  pnpm impute:build --chr $chr --population EUR
done
```

### Expected Impact

- **Before**: PGS with 530K variants → 8K matched (1.5%) → Quality score: 28 (poor)
- **After**: PGS with 530K variants → 350K matched (66%) → Quality score: 75 (good)

---

## 📋 Phase 7: Community & Monetization (FUTURE)

**Objective:** Build community and sustainable business model.

See [CLOUD_IMPUTATION_TODO.md](docs/CLOUD_IMPUTATION_TODO.md) for the detailed plan on paid cloud imputation — the primary revenue driver and Tier 2 entry point.

### Planned Features

#### Open Source Engine

- Public GitHub repository with AGPLv3 license
- Community contributions for new DNA formats
- Plugin system for custom trait calculations
- Developer documentation and examples

**AGPLv3 Protection:**

- Prevents proprietary forks
- Requires sharing of modifications
- Network copyleft for web services
- Ensures community benefits from improvements

#### Premium Data Curation

- **Free Tier:** Basic traits from PGS Catalog
- **Premium Packs:** Curated trait collections
  - Athletic Performance Pack
  - Longevity & Healthspan Pack
  - Nutrition & Metabolism Pack
  - Mental Health & Cognition Pack

#### Authentication & Payments

- Firebase Auth or Supabase for user accounts
- Stripe integration for premium pack purchases
- Signed URLs for premium Parquet files
- Subscription management

#### Advanced Features

- Family risk aggregation and inheritance patterns
- Trait correlation analysis
- Export to PDF reports
- Integration with health tracking apps
- Research data contribution (opt-in, anonymized)

---

## Current Architecture Summary

### Deployment Modes

1. **Browser-Only** (`docker-compose.yml`)
   - Static hosting with Nginx
   - All processing in browser with DuckDB WASM
   - Best for: Privacy-focused users, static hosting

2. **Hybrid Server** (`docker-compose.hybrid.yml`)
   - Web UI + calculation server
   - Server handles heavy computations
   - WebSocket for real-time updates
   - Best for: Home servers, family use

3. **Containerized** (Future)
   - Single Docker image with all components
   - Multi-user support
   - Best for: Self-hosting, enterprise

### Technology Stack

- **Frontend:** Web Components, DuckDB WASM, IndexedDB
- **Backend:** Node.js, DuckDB (native), SQLite
- **Data:** Parquet files with ZSTD compression
- **Pipeline:** Node.js ETL with PGS Catalog integration
- **Deployment:** Docker, Nginx, static hosting

### Data Flow

```
PGS Catalog → Pipeline → Parquet Files → CDN/Server
                                            ↓
User DNA File → Browser/Server → DuckDB → Risk Scores
                                            ↓
                                    IndexedDB/SQLite
```

---

## Next Steps

1. **Immediate (This Week)**
   - Clean up test files and abandoned code
   - Add CONTRIBUTING.md and LICENSE
   - Document API endpoints
   - Add JSDoc comments to core modules

2. **Short Term (This Month)**
   - Write comprehensive tests
   - Set up GitHub Actions CI/CD
   - Create deployment guides
   - Security audit

3. **Medium Term (Next Quarter)**
   - Public beta release
   - Community feedback and iteration
   - Premium pack development
   - Authentication integration

4. **Long Term (6-12 Months)**
   - Mobile app development
   - Advanced analytics features
   - Research partnerships
   - Scale to thousands of users

---

## Success Metrics

- **Privacy:** Zero data breaches, all processing local
- **Performance:** <5s for single trait calculation
- **Usability:** <3 clicks from DNA upload to first result
- **Community:** 100+ GitHub stars, 10+ contributors
- **Business:** 1000+ users, 100+ premium subscribers

---

## Contributing

We welcome contributions! Areas where help is needed:

- DNA file format parsers (new providers)
- Trait curation and validation
- Performance optimization
- Documentation and tutorials
- Testing and bug reports
- UI/UX improvements

See CONTRIBUTING.md for guidelines (coming soon).

---

## License

MIT License - See LICENSE file for details.

Your DNA data is yours alone. Asili simply provides the tools to analyze it privately.
