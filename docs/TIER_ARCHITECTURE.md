# Asili Tier & Build Architecture

## Philosophy

Asili balances **Data Freedom** with **legal and regulatory safety** through a tiered build system controlled by trait ID allowlists.

The core mathematical engine makes no distinction between a "benign" trait and a "disease" trait. Restriction happens entirely at the ETL and deployment layers. This means the same codebase powers every tier — the only difference is which Parquet data packs are accessible.

---

## The Master Catalog

The ETL pipeline compiles the **Master Catalog**: every viable trait from the PGS Catalog that has been successfully LD-clumped and matched against gnomAD baseline frequencies. This is stored in `trait_manifest.db` and exported as `trait_manifest.json`.

The committed `trait_catalog.json` serves as a **seed and override file** — it provides editorial names, descriptions, and ensures specific traits are always included. But the pipeline's database is the source of truth for what's _available_. The allowlists control what's _deployed_.

**Rule:** The unfiltered Master Catalog is _never_ deployed to public web hosting.

---

## The Build Tiers

### Tier 1: Public Web (Free)

The publicly accessible static site. Zero liability, zero cost to operate.

| | |
|---|---|
| **Audience** | General public, curious 23andMe/Ancestry customers |
| **Deployment** | Static CDN (Netlify, Vercel, S3+CloudFront) |
| **Processing** | Browser-only — DuckDB WASM, no server |
| **Imputation** | None — raw DTC genotype coverage only (~2-5%) |
| **Allowlist** | `allowlists/tier1_public.json` (~25 traits) |
| **Auth** | None |
| **Cost to User** | Free |
| **Liability** | Zero — no disease traits, no medical device implications |

**Build mechanism:**
```bash
# GitHub Actions or local
ASILI_TIER=1 pnpm run build
# Filters trait_manifest.json through tier1_public.json
# Copies only matching Parquet packs to deploy output
```

**Trait scope — strictly benign, anthropometric, and lifestyle:**

| Category | Traits |
|----------|--------|
| Body | BMI, height, body weight, waist circumference, waist-hip ratio, body composition |
| Metabolism | Basal metabolic rate, carbohydrate intake, alcohol consumption |
| Cardiovascular | Heart rate, systolic blood pressure, diastolic blood pressure |
| Lifestyle | Chronotype (morning/evening), smoking status, neuroticism score |
| Appearance | Male pattern baldness, suntan response |
| Nutrition | Vitamin D level, vitamin B12 level |
| Reproductive | Age at menarche, age at menopause, number of children |
| Longevity | Lifespan |

These are traits where the result is interesting conversation, not a source of medical anxiety. "You're genetically a morning person" is fun. "You have elevated Alzheimer's risk" is not something to serve without informed consent.

**Purpose:** Prove the product, build audience, collect email signups, drive GitHub stars, funnel users toward Tier 2.

---

### Tier 2: Researcher Pro (Paid)

The full-power hosted version. This is where revenue comes from.

| | |
|---|---|
| **Audience** | Biohackers, amateur researchers, quantified-self enthusiasts, academic researchers |
| **Deployment** | Hosted alongside Tier 1, gated behind auth |
| **Processing** | Server-assisted — ephemeral imputation + calculation |
| **Imputation** | Full Beagle 5.4 + TOPMed panel (~60-80% coverage) |
| **Allowlist** | `allowlists/tier2_researcher.json` (full Master Catalog) |
| **Auth** | Account + Researcher Agreement signature |
| **Cost to User** | Paid (see pricing below) |
| **Liability** | Shielded by Researcher Agreement (`RESEARCHER_AGREEMENT.md`) |

#### What We're Selling

The PGS Catalog data is public. Anyone can download it. What they _can't_ easily do:

1. **Imputation** — requires TOPMed reference panel (150GB), Beagle, and significant compute
2. **Processing** — millions of variants across 100+ PGS scores, LD-clumped and normalized
3. **Curation** — quality-scored, editorially described, properly categorized results
4. **Convenience** — upload a file, get a comprehensive report, no bioinformatics PhD required

We're selling **compute + curation**, not data.

#### Pricing Model

| Plan | What They Get | Price |
|------|--------------|-------|
| **Single Report** | One-time full imputation, all traits, downloadable result pack | $15-30 |
| **Pro Monthly** | Ongoing access, re-imputation as new PGS are published, priority processing | $5-10/mo |
| **Research Institutional** | Bulk processing, API access, custom trait sets | Custom |

The Single Report is the entry point — low friction, one-time purchase, immediate value. Monthly subscription is for people who want to stay current as the PGS Catalog grows and scores improve.

#### The Privacy Problem (and Solution)

Imputation requires server-side compute. This conflicts with the "your data never leaves your machine" promise. Two approaches:

**Option A: Ephemeral Processing (recommended for launch)**
1. User uploads DNA file over TLS
2. Server imputes in an isolated container
3. Results are encrypted with a user-derived key
4. Encrypted results are returned to the browser / available for download
5. Raw DNA and intermediate files are deleted within minutes
6. Server retains _nothing_ — only the user has their results
7. All of this is documented in a clear, auditable privacy policy

**Option B: Bring Your Own Compute (power users)**
1. User downloads a Docker image with the imputation pipeline
2. Runs imputation locally (requires ~16GB RAM, ~30 min)
3. Uploads only the _imputed VCF_ for scoring (less sensitive than raw genotypes)
4. Or runs the full pipeline locally and just pays for access to the curated Parquet packs via signed URLs

Option A is simpler for most users. Option B satisfies privacy purists who want Tier 2 curation without Tier 2 trust. Both can coexist.

#### Auth & Payments

- **Auth:** Simple JWT-based accounts. Email + password or OAuth (GitHub, Google). No need for a heavy identity provider at launch.
- **Payments:** Stripe Checkout for one-time purchases, Stripe Billing for subscriptions.
- **Researcher Agreement:** Digital signature during signup — checkbox + timestamp + IP, stored as part of the account record. The existing `RESEARCHER_AGREEMENT.md` content is solid.
- **Data Access:** Tier 2 Parquet packs are stored in a protected bucket. Authenticated users receive time-limited signed URLs. The browser's DuckDB WASM fetches Parquet data via HTTP Range Requests using these URLs — same architecture as Tier 1, just with an auth layer in front.

#### Build Mechanism

```bash
# Tier 2 data packs are built separately and pushed to protected storage
ASILI_TIER=2 pnpm run build
# Generates full trait_manifest.json + all Parquet packs
# Uploads to protected S3 bucket (not the public CDN)
```

The web app detects the user's tier at runtime via their auth token and loads the appropriate manifest:
- Anonymous → `trait_manifest.json` (Tier 1, filtered)
- Authenticated Pro → `trait_manifest_full.json` (Tier 2, signed URL)

---

### Tier 3: Local Docker (Open Source, Maximum Freedom)

The full open-source engine running on the user's own hardware.

| | |
|---|---|
| **Audience** | Advanced tinkerers, privacy purists, self-hosters |
| **Deployment** | Docker Compose on user's machine |
| **Processing** | Full hybrid — local imputation + local calculation |
| **Imputation** | User sets up their own Beagle + reference panel |
| **Allowlist** | User's choice — any allowlist or `--allowlist=none` |
| **Auth** | None (local) |
| **Cost to User** | Free (AGPLv3) |
| **Liability** | None — user runs open-source code on their own hardware with public data |

**Build mechanism:**
```bash
# User clones repo and runs everything locally
docker compose up -d
pnpm etl                          # Builds Master Catalog from PGS Catalog API
pnpm imputation setup-topmed      # Downloads TOPMed panel (150GB)
pnpm imputation impute            # Imputes their DNA
# All traits available, no restrictions
```

**What's sellable in Tier 3?** Nothing directly, and that's by design. The AGPLv3 license ensures anyone who modifies and hosts Asili as a service must open-source their changes. Tier 3 exists to:

- Build community trust and credibility
- Drive GitHub stars and contributions
- Serve as a funnel — users who try Tier 3 and find it complex become Tier 2 customers
- Attract developer contributors who improve the engine for everyone

---

## Allowlist System

### Directory Structure

```
allowlists/
├── tier1_public.json        # ~25 safe, benign traits
├── tier2_researcher.json    # Full Master Catalog ("*" wildcard)
└── README.md                # Curation guidelines
```

### Allowlist Format

```json
{
  "tier": "public",
  "version": "1.0",
  "description": "Tier 1: Benign anthropometric and lifestyle traits only",
  "traits": [
    "EFO_0004340",
    "OBA_VT0001253",
    "EFO_0004338",
    "EFO_0008328"
  ]
}
```

For Tier 2, the allowlist can use a wildcard to include everything:

```json
{
  "tier": "researcher",
  "version": "1.0",
  "description": "Tier 2: Full Master Catalog",
  "traits": ["*"]
}
```

### How Filtering Works

The allowlist is applied at two points:

1. **ETL export** (`export-manifest.js`): When generating `trait_manifest.json` for a deployment, only traits in the active allowlist are included. Parquet packs for excluded traits are not copied to the deploy output.

2. **Settings generator** (`settings-generator.js`): The `ASILI_TIER` environment variable is written into `settings.json`, allowing the frontend to know which tier it's running as (for UI messaging, upgrade prompts, etc.).

```
ETL Pipeline
    │
    ▼
Master Catalog (trait_manifest.db) ── all traits
    │
    ├── ASILI_TIER=1 ──▶ tier1_public.json filter ──▶ Public CDN (~25 traits)
    ├── ASILI_TIER=2 ──▶ tier2_researcher.json filter ──▶ Protected bucket (all traits)
    └── ASILI_TIER=3 ──▶ no filter ──▶ Local Docker (all traits)
```

---

## How to Add a New Trait

1. Ensure the trait exists in the PGS Catalog with sufficient variant coverage.
2. Run the ETL pipeline — it will automatically discover, clump, and process the trait into the Master Catalog.
3. To expose it to Tier 1 users, add its Trait ID (e.g., `EFO_0004340`) to `allowlists/tier1_public.json`. **Only add traits that are benign, non-medical, and non-anxiety-inducing.**
4. Tier 2 users get everything automatically (wildcard allowlist).
5. Tier 3 users have no restrictions.

### Tier 1 Curation Guidelines

A trait belongs in Tier 1 **only** if ALL of the following are true:

- ✅ It describes a **measurable physical characteristic** or **lifestyle tendency** (not a disease)
- ✅ Learning your score would be **interesting or fun**, not distressing
- ✅ It has **no medical diagnostic implications** (not used to screen for or diagnose conditions)
- ✅ It would **not** cause a reasonable person to seek medical attention based solely on the score
- ✅ It does **not** fall under FDA medical device definitions

**Examples of Tier 1 traits:** BMI, height, chronotype, caffeine metabolism, hair loss pattern, suntan response

**Examples of traits that are NOT Tier 1:** Alzheimer's disease, any cancer, depression, diabetes, autoimmune conditions

---

## Launch Sequence

### Phase A: Allowlist Infrastructure (Week 1-2)
- [ ] Create `allowlists/` directory with `tier1_public.json` and `tier2_researcher.json`
- [ ] Modify `catalog.js` to accept an allowlist filter parameter
- [ ] Add `ASILI_TIER` env var to `settings-generator.js`
- [ ] Modify `export-manifest.js` to filter output by allowlist
- [ ] Add `--tier` flag to ETL runner scripts

### Phase B: Ship Tier 1 (Week 3)
- [ ] Curate ~25 Tier 1 trait descriptions for a general audience
- [ ] GitHub Actions workflow: build with `ASILI_TIER=1`, deploy to CDN
- [ ] Landing page with email capture and "Upgrade to Pro" messaging
- [ ] Verify no disease/medical traits leak through

### Phase C: Tier 2 Infrastructure (Week 4-6)
- [ ] Stripe Checkout integration (one-time report + monthly subscription)
- [ ] Simple JWT auth (email/password + OAuth)
- [ ] Researcher Agreement digital signature flow
- [ ] Signed URL generation for protected Parquet bucket
- [ ] Ephemeral imputation pipeline (upload → impute → encrypt → return → delete)
- [ ] Runtime tier detection in frontend (anonymous vs. authenticated)

### Phase D: Tier 3 Polish (Ongoing)
- [ ] Clean up Docker image for public distribution
- [ ] Self-hosting documentation
- [ ] `--allowlist=none` flag for unrestricted local builds
- [ ] Community engagement, GitHub presence

---

## Revenue Projections (Conservative)

| Metric | Month 1 | Month 6 | Month 12 |
|--------|---------|---------|----------|
| Tier 1 users | 100 | 1,000 | 5,000 |
| Tier 2 single reports ($20 avg) | 5 | 50 | 200 |
| Tier 2 monthly subs ($8/mo) | 2 | 30 | 100 |
| Monthly revenue | $116 | $1,240 | $4,800 |

These are conservative. The genomics consumer market is growing, and there's no real competitor offering privacy-first PGS analysis at this price point. 23andMe charges $200+ and owns your data.

---

## Regulatory Notes

- **Tier 1** is completely insulated from FDA medical device definitions. No disease traits, no diagnostic claims.
- **Tier 2** is shielded by the Researcher Agreement, which establishes informed consent, disclaims medical advice, and transfers assumption of risk. This is the same model used by Promethease, SNPedia, and similar tools.
- **Tier 3** carries zero liability — we provide open-source code, the user fetches public data and runs it on their own hardware.
- **None of the tiers** make diagnostic claims. All results are presented as "polygenic risk scores from published research" with appropriate caveats about population stratification, coverage limitations, and the probabilistic nature of PGS.
