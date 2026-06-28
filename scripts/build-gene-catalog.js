#!/usr/bin/env node

/**
 * Build popular gene catalog for the Explore feature.
 *
 * Downloads NCBI bulk files to rank genes by publication count,
 * then fetches exact hg38 coordinates via esummary API.
 *
 * Data sources:
 *   - gene_info: symbol, chromosome, description, type
 *   - gene2pubmed: publication count (popularity signal)
 *   - esummary API: exact hg38 start/end coordinates
 *
 * Usage:
 *   node scripts/build-gene-catalog.js              # Full build
 *   node scripts/build-gene-catalog.js --offline    # Use cached data only
 *   node scripts/build-gene-catalog.js --top=200    # Limit gene count
 *
 * Output: data_out/gene_catalog.json
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import path from 'path';

const OUTPUT_DIR = process.env.OUTPUT_DIR || 'data_out';
const OUTPUT_FILE = path.resolve(OUTPUT_DIR, 'gene_catalog.json');
const CACHE_DIR = path.resolve('cache/ncbi_genes');
const OVERRIDES_FILE = path.resolve('data/gene_overrides.json');

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const topArg = args.find((a) => a.startsWith('--top='));
const TOP_N = topArg ? parseInt(topArg.split('=')[1]) : 201;

const GENE_INFO_URL =
  'https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/Homo_sapiens.gene_info.gz';
const GENE2PUBMED_URL = 'https://ftp.ncbi.nlm.nih.gov/gene/DATA/gene2pubmed.gz';

const HUMAN_TAX_ID = '9606';

/**
 * Curated social context for well-known genes.
 * Only needs symbol — IDs resolved automatically from gene_info.
 */
const SOCIAL_CONTEXT = {
  TP53: { social_tags: ['tumor suppressor', 'guardian of the genome', 'Li-Fraumeni', 'cancer mutations'], category: 'Cancer Risk', popular_variants: ['rs1042522', 'rs28934578'], wikipedia_slug: 'P53' },
  BRCA1: { social_tags: ['breast cancer', 'hereditary', 'Angelina Jolie', 'ovarian cancer'], category: 'Cancer Risk', popular_variants: ['rs80357906', 'rs80357713'], wikipedia_slug: 'BRCA1' },
  BRCA2: { social_tags: ['breast cancer', 'hereditary', 'pancreatic cancer', 'prostate cancer'], category: 'Cancer Risk', popular_variants: ['rs80359550'], wikipedia_slug: 'BRCA2' },
  EGFR: { social_tags: ['lung cancer', 'targeted therapy', 'tyrosine kinase'], category: 'Cancer Risk', popular_variants: ['rs2227983'], wikipedia_slug: 'Epidermal_growth_factor_receptor' },
  ERBB2: { social_tags: ['HER2', 'breast cancer', 'Herceptin', 'targeted therapy'], category: 'Cancer Risk', popular_variants: [], wikipedia_slug: 'HER2/neu' },
  PTEN: { social_tags: ['tumor suppressor', 'Cowden syndrome', 'PI3K pathway'], category: 'Cancer Risk', popular_variants: [], wikipedia_slug: 'PTEN_(gene)' },
  KRAS: { social_tags: ['pancreatic cancer', 'colorectal cancer', 'oncogene', 'RAS pathway'], category: 'Cancer Risk', popular_variants: [], wikipedia_slug: 'KRAS' },
  BRAF: { social_tags: ['melanoma', 'V600E mutation', 'targeted therapy'], category: 'Cancer Risk', popular_variants: ['rs113488022'], wikipedia_slug: 'BRAF_(gene)' },
  CDH1: { social_tags: ['stomach cancer', 'lobular breast cancer', 'E-cadherin'], category: 'Cancer Risk', popular_variants: [], wikipedia_slug: 'CDH1_(gene)' },
  CDKN2A: { social_tags: ['melanoma', 'p16', 'cell cycle', 'aging'], category: 'Cancer Risk', popular_variants: [], wikipedia_slug: 'P16_(gene)' },

  APOE: { social_tags: ["Alzheimer's", 'e4 allele', 'cholesterol transport', 'longevity'], category: 'Brain & Mood', popular_variants: ['rs429358', 'rs7412'], wikipedia_slug: 'Apolipoprotein_E' },
  APP: { social_tags: ["Alzheimer's", 'amyloid', 'dementia', 'plaques'], category: 'Brain & Mood', popular_variants: [], wikipedia_slug: 'Amyloid_precursor_protein' },
  BDNF: { social_tags: ['brain growth', 'neuroplasticity', 'exercise benefit', 'memory'], category: 'Brain & Mood', popular_variants: ['rs6265'], wikipedia_slug: 'Brain-derived_neurotrophic_factor' },
  COMT: { social_tags: ['warrior vs worrier', 'dopamine', 'stress response', 'focus'], category: 'Brain & Mood', popular_variants: ['rs4680'], wikipedia_slug: 'Catechol-O-methyltransferase' },
  SLC6A4: { social_tags: ['serotonin transporter', '5-HTTLPR', 'depression', 'SSRI response'], category: 'Brain & Mood', popular_variants: ['rs25531'], wikipedia_slug: 'Serotonin_transporter' },
  MAPT: { social_tags: ['tau protein', "Alzheimer's", 'frontotemporal dementia', 'Parkinson'], category: 'Brain & Mood', popular_variants: ['rs10445337'], wikipedia_slug: 'Microtubule-associated_protein_tau' },
  SNCA: { social_tags: ["Parkinson's", 'alpha-synuclein', 'Lewy bodies', 'neurodegeneration'], category: 'Brain & Mood', popular_variants: ['rs356219'], wikipedia_slug: 'Alpha-synuclein' },

  TNF: { social_tags: ['inflammation', 'autoimmune', 'cytokine', 'rheumatoid arthritis'], category: 'Immunity & Inflammation', popular_variants: ['rs1800629'], wikipedia_slug: 'Tumor_necrosis_factor' },
  IL6: { social_tags: ['inflammation', 'aging', 'cytokine storm', 'exercise'], category: 'Immunity & Inflammation', popular_variants: ['rs1800795'], wikipedia_slug: 'Interleukin_6' },
  IL1B: { social_tags: ['inflammation', 'fever', 'chronic disease', 'cytokine'], category: 'Immunity & Inflammation', popular_variants: ['rs16944', 'rs1143634'], wikipedia_slug: 'Interleukin_1_beta' },
  IL10: { social_tags: ['anti-inflammatory', 'immune regulation', 'autoimmune'], category: 'Immunity & Inflammation', popular_variants: ['rs1800896'], wikipedia_slug: 'Interleukin_10' },
  HLA_B: { social_tags: ['drug reactions', 'abacavir', 'immune diversity', 'MHC'], category: 'Immunity & Inflammation', popular_variants: ['rs2395029'], wikipedia_slug: 'HLA-B' },
  HLA_DRB1: { social_tags: ['autoimmune diseases', 'rheumatoid arthritis', 'transplant'], category: 'Immunity & Inflammation', popular_variants: [], wikipedia_slug: 'HLA-DRB1' },
  TLR4: { social_tags: ['innate immunity', 'sepsis', 'pathogen recognition'], category: 'Immunity & Inflammation', popular_variants: ['rs4986790'], wikipedia_slug: 'Toll-like_receptor_4' },
  IFNG: { social_tags: ['interferon gamma', 'immune activation', 'viral defense'], category: 'Immunity & Inflammation', popular_variants: ['rs2430561'], wikipedia_slug: 'Interferon_gamma' },
  CRP: { social_tags: ['inflammation marker', 'heart disease risk', 'blood test'], category: 'Immunity & Inflammation', popular_variants: ['rs1205', 'rs3091244'], wikipedia_slug: 'C-reactive_protein' },

  ACE: { social_tags: ['blood pressure', 'athletic endurance', 'ACE inhibitors'], category: 'Heart & Cardiovascular', popular_variants: ['rs4646994'], wikipedia_slug: 'Angiotensin-converting_enzyme' },
  NOS3: { social_tags: ['nitric oxide', 'blood vessel dilation', 'cardiovascular'], category: 'Heart & Cardiovascular', popular_variants: ['rs1799983'], wikipedia_slug: 'Endothelial_NOS' },
  APOB: { social_tags: ['familial hypercholesterolemia', 'LDL particle'], category: 'Heart & Cardiovascular', popular_variants: ['rs5742904', 'rs693'], wikipedia_slug: 'Apolipoprotein_B' },

  ESR1: { social_tags: ['estrogen receptor', 'bone density', 'breast cancer', 'HRT'], category: 'Hormones & Fertility', popular_variants: ['rs2234693', 'rs9340799'], wikipedia_slug: 'Estrogen_receptor_alpha' },
  AR: { social_tags: ['testosterone', 'androgen receptor', 'hair loss', 'PCOS'], category: 'Hormones & Fertility', popular_variants: ['rs6152'], wikipedia_slug: 'Androgen_receptor' },
  IGF1: { social_tags: ['growth factor', 'muscle', 'aging', 'height'], category: 'Hormones & Fertility', popular_variants: ['rs35767'], wikipedia_slug: 'Insulin-like_growth_factor_1' },

  MTHFR: { social_tags: ['folate', 'methylation', 'dirty genes', 'B12', 'homocysteine'], category: 'Vitamins & Nutrients', popular_variants: ['rs1801133', 'rs1801131'], wikipedia_slug: 'Methylenetetrahydrofolate_reductase' },
  VDR: { social_tags: ['vitamin D receptor', 'bone health', 'immune function', 'sun'], category: 'Vitamins & Nutrients', popular_variants: ['rs2228570', 'rs1544410'], wikipedia_slug: 'Vitamin_D_receptor' },

  FTO: { social_tags: ['obesity gene', 'appetite', 'fat mass', 'weight gain'], category: 'Metabolism & Weight', popular_variants: ['rs9939609', 'rs1558902'], wikipedia_slug: 'FTO_gene' },
  PPARG: { social_tags: ['fat storage', 'insulin sensitivity', 'type 2 diabetes'], category: 'Metabolism & Weight', popular_variants: ['rs1801282'], wikipedia_slug: 'Peroxisome_proliferator-activated_receptor_gamma' },
  ADIPOQ: { social_tags: ['adiponectin', 'metabolic health', 'insulin sensitivity', 'fat hormone'], category: 'Metabolism & Weight', popular_variants: ['rs2241766', 'rs1501299'], wikipedia_slug: 'Adiponectin' },

  ABCB1: { social_tags: ['drug transport', 'P-glycoprotein', 'blood-brain barrier', 'drug resistance'], category: 'Detox & Drug Metabolism', popular_variants: ['rs1045642', 'rs1128503'], wikipedia_slug: 'P-glycoprotein' },
  GSTM1: { social_tags: ['detoxification', 'glutathione', 'null genotype', 'cancer risk'], category: 'Detox & Drug Metabolism', popular_variants: [], wikipedia_slug: 'Glutathione_S-transferase_Mu_1' },

  TERT: { social_tags: ['telomere length', 'aging', 'cellular lifespan', 'telomerase'], category: 'Longevity', popular_variants: ['rs2736100'], wikipedia_slug: 'Telomerase_reverse_transcriptase' },
  FOXO3: { social_tags: ['longevity gene', 'centenarians', 'aging', 'stress resistance'], category: 'Longevity', popular_variants: ['rs2802292'], wikipedia_slug: 'FOXO3' },

  HIF1A: { social_tags: ['altitude adaptation', 'oxygen sensing', 'endurance'], category: 'Fitness & Athletic', popular_variants: ['rs11549465'], wikipedia_slug: 'Hypoxia-inducible_factor_1-alpha' },

  VEGFA: { social_tags: ['blood vessel growth', 'wound healing', 'macular degeneration'], category: 'Cancer Risk', popular_variants: ['rs2010963'], wikipedia_slug: 'Vascular_endothelial_growth_factor_A' },
  TGFB1: { social_tags: ['fibrosis', 'immune regulation', 'wound healing', 'scarring'], category: 'Immunity & Inflammation', popular_variants: ['rs1800469'], wikipedia_slug: 'Transforming_growth_factor_beta_1' },
  CFTR: { social_tags: ['cystic fibrosis', 'delta F508', 'lung disease', 'carrier screening'], category: 'Immunity & Inflammation', popular_variants: ['rs75527207', 'rs113993960'], wikipedia_slug: 'Cystic_fibrosis_transmembrane_conductance_regulator' },
  MTOR: { social_tags: ['rapamycin', 'aging', 'autophagy', 'cell growth', 'longevity'], category: 'Longevity', popular_variants: [], wikipedia_slug: 'MTOR' },
  BCL2: { social_tags: ['apoptosis', 'cell death', 'lymphoma', 'survival'], category: 'Cancer Risk', popular_variants: [], wikipedia_slug: 'Bcl-2' },
  NFE2L2: { social_tags: ['Nrf2', 'antioxidant defense', 'detox pathways', 'broccoli'], category: 'Longevity', popular_variants: ['rs6721961'], wikipedia_slug: 'NFE2L2' },
  PTGS2: { social_tags: ['COX-2', 'inflammation', 'aspirin target', 'pain'], category: 'Immunity & Inflammation', popular_variants: ['rs20417'], wikipedia_slug: 'Prostaglandin-endoperoxide_synthase_2' },
};

// Normalize HLA symbols (replace _ with - for lookup)
const SOCIAL_LOOKUP = Object.fromEntries(
  Object.entries(SOCIAL_CONTEXT).map(([k, v]) => [k.replace(/_/g, '-'), v])
);

/**
 * Auto-assign category based on gene description when no curated context exists.
 */
function inferCategory(description) {
  const d = description.toLowerCase();
  if (d.includes('cancer') || d.includes('tumor') || d.includes('oncogene')) return 'Cancer Risk';
  if (d.includes('interleukin') || d.includes('immune') || d.includes('toll') || d.includes('interferon')) return 'Immunity & Inflammation';
  if (d.includes('heart') || d.includes('cardio') || d.includes('angiotensin') || d.includes('cholesterol')) return 'Heart & Cardiovascular';
  if (d.includes('dopamine') || d.includes('serotonin') || d.includes('neuro') || d.includes('brain')) return 'Brain & Mood';
  if (d.includes('insulin') || d.includes('glucose') || d.includes('adipon') || d.includes('metabol')) return 'Metabolism & Weight';
  if (d.includes('cytochrome') || d.includes('transferase') || d.includes('oxidase')) return 'Detox & Drug Metabolism';
  if (d.includes('hormone') || d.includes('estrogen') || d.includes('androgen') || d.includes('receptor')) return 'Hormones & Fertility';
  if (d.includes('telomer') || d.includes('sirtuin') || d.includes('aging')) return 'Longevity';
  return 'Other';
}

/**
 * Stream-download and gunzip a URL, processing lines via callback.
 */
async function streamGzLines(url, cacheName, onLine) {
  const cachePath = path.join(CACHE_DIR, cacheName);

  let input;
  if (offline || existsSync(cachePath)) {
    if (!existsSync(cachePath)) throw new Error(`No cached ${cacheName}. Run without --offline.`);
    const { createReadStream } = await import('fs');
    input = createReadStream(cachePath).pipe(createGunzip());
  } else {
    console.log(`  Downloading ${url.split('/').pop()}...`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);

    // Save to cache while streaming
    const cacheStream = createWriteStream(cachePath);
    const tee = new PassThrough();
    Readable.fromWeb(resp.body).pipe(tee);
    tee.pipe(cacheStream);
    // Can't easily tee and gunzip simultaneously, so save raw then re-read
    await new Promise((resolve, reject) => {
      cacheStream.on('finish', resolve);
      cacheStream.on('error', reject);
      Readable.fromWeb(resp.body).pipe(cacheStream);
    });

    // Nope — simpler: download to cache first, then read
    throw new Error('unreachable');
  }

  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.startsWith('#')) continue;
    onLine(line);
  }
}

/**
 * Download a gzipped file to cache.
 */
async function downloadToCache(url, cacheName) {
  const cachePath = path.join(CACHE_DIR, cacheName);
  if (existsSync(cachePath)) {
    console.log(`  Using cached ${cacheName}`);
    return cachePath;
  }
  if (offline) throw new Error(`No cached ${cacheName}. Run without --offline.`);

  console.log(`  Downloading ${cacheName}...`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);

  const dest = createWriteStream(cachePath);
  await new Promise((resolve, reject) => {
    Readable.fromWeb(resp.body).pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
  });

  return cachePath;
}

/**
 * Read gzipped TSV file line by line.
 */
async function readGzLines(filePath, onLine) {
  const { createReadStream } = await import('fs');
  const input = createReadStream(filePath).pipe(createGunzip());
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.startsWith('#')) continue;
    onLine(line);
  }
}

/**
 * Count publications per human gene from gene2pubmed.
 */
async function countPublications(filePath) {
  const counts = {};
  let total = 0;

  await readGzLines(filePath, (line) => {
    const tab1 = line.indexOf('\t');
    const taxId = line.slice(0, tab1);
    if (taxId !== HUMAN_TAX_ID) return;

    const tab2 = line.indexOf('\t', tab1 + 1);
    const geneId = line.slice(tab1 + 1, tab2);
    counts[geneId] = (counts[geneId] || 0) + 1;
    total++;
  });

  console.log(`  ${total.toLocaleString()} human gene–publication links`);
  return counts;
}

/**
 * Load gene_info for protein-coding human genes.
 */
async function loadGeneInfo(filePath) {
  const genes = {};

  await readGzLines(filePath, (line) => {
    const cols = line.split('\t');
    // Columns: tax_id, GeneID, Symbol, LocusTag, Synonyms, dbXrefs, chromosome,
    //          map_location, description, type_of_gene, Symbol_from_nomenclature,
    //          Full_name, Nomenclature_status, Other_designations, Modification_date
    if (cols[9] !== 'protein-coding') return;

    const chr = cols[6];
    if (chr === '-' || chr === 'MT' || chr === 'Y' || chr === 'Un') return;
    if (chr.includes('|')) return;

    const synonyms = cols[4] !== '-' ? cols[4].split('|') : [];
    const fullName = cols[11] !== '-' ? cols[11] : null;

    genes[cols[1]] = {
      id: cols[1],
      symbol: cols[2],
      chr,
      description: cols[8],
      synonyms,
      full_name: fullName,
      map_location: cols[7] !== '-' ? cols[7] : null,
    };
  });

  console.log(`  ${Object.keys(genes).length.toLocaleString()} protein-coding genes loaded`);
  return genes;
}

/**
 * Fetch gene details from NCBI esummary API.
 * Returns coordinates, summary, aliases, exon count, OMIM IDs.
 * Batches 200 IDs per request.
 */
async function fetchGeneDetails(geneIds) {
  const BATCH_SIZE = 200;
  const details = {};

  for (let i = 0; i < geneIds.length; i += BATCH_SIZE) {
    const batch = geneIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(geneIds.length / BATCH_SIZE);
    console.log(`  Fetching details batch ${batchNum}/${totalBatches} (${batch.length} genes)...`);

    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gene&id=${batch.join(',')}&retmode=json`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`NCBI API error: ${resp.status}`);
    const data = await resp.json();

    for (const id of batch) {
      const doc = data.result?.[String(id)];
      if (!doc?.genomicinfo?.length) continue;

      const info = doc.genomicinfo[0];
      details[id] = {
        chr: info.chrloc,
        start: Math.min(info.chrstart, info.chrstop),
        end: Math.max(info.chrstart, info.chrstop),
        exon_count: info.exoncount || null,
        summary: doc.summary || null,
        aliases: doc.otheraliases ? doc.otheraliases.split(', ') : [],
        mim_ids: doc.mim || [],
      };
    }

    // Rate limit
    if (i + BATCH_SIZE < geneIds.length) {
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  return details;
}

async function main() {
  console.log(`\n🧬 Building popular gene catalog (top ${TOP_N})...\n`);
  const startTime = Date.now();
  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Step 1: Download bulk files
  console.log('📥 Downloading NCBI bulk data...');
  const geneInfoPath = await downloadToCache(GENE_INFO_URL, 'Homo_sapiens.gene_info.gz');
  const gene2pubmedPath = await downloadToCache(GENE2PUBMED_URL, 'gene2pubmed.gz');

  // Step 2: Count publications per gene
  console.log('\n📊 Counting publications per gene...');
  const pubCounts = await countPublications(gene2pubmedPath);

  // Step 3: Load gene info
  console.log('\n📋 Loading gene info...');
  const geneInfo = await loadGeneInfo(geneInfoPath);

  // Step 4: Rank by publication count, take top N
  console.log(`\n🏆 Ranking top ${TOP_N} by publication count...`);
  const ranked = Object.keys(geneInfo)
    .filter((id) => pubCounts[id] && pubCounts[id] >= 50)
    .sort((a, b) => (pubCounts[b] || 0) - (pubCounts[a] || 0))
    .slice(0, TOP_N);

  console.log(`  #1: ${geneInfo[ranked[0]].symbol} (${pubCounts[ranked[0]].toLocaleString()} pubs)`);
  console.log(`  #${TOP_N}: ${geneInfo[ranked[TOP_N - 1]].symbol} (${pubCounts[ranked[TOP_N - 1]].toLocaleString()} pubs)`);

  // Step 5: Fetch gene details from API
  console.log("\n🌐 Fetching gene details from NCBI...");
  const detailsCache = path.join(CACHE_DIR, "gene_details.json");
  let details;

  if (existsSync(detailsCache) && offline) {
    details = JSON.parse(readFileSync(detailsCache, "utf8"));
  } else if (existsSync(detailsCache)) {
    const cached = JSON.parse(readFileSync(detailsCache, "utf8"));
    const missing = ranked.filter((id) => !cached[id]);
    if (missing.length === 0) {
      console.log("  Using cached gene details");
      details = cached;
    } else {
      console.log(`  ${missing.length} genes need detail lookup...`);
      const fresh = await fetchGeneDetails(missing);
      details = { ...cached, ...fresh };
      writeFileSync(detailsCache, JSON.stringify(details, null, 2));
    }
  } else {
    details = await fetchGeneDetails(ranked);
    writeFileSync(detailsCache, JSON.stringify(details, null, 2));
  }

























  // Step 6: Build catalog
  console.log('\n🔧 Building catalog...');

  // Load editorial overrides
  let overrides = {};
  if (existsSync(OVERRIDES_FILE)) {
    overrides = JSON.parse(readFileSync(OVERRIDES_FILE, 'utf8'));
    console.log(`  ${Object.keys(overrides).length} editorial overrides loaded`);
  }

  const genes = [];
  let withContext = 0;

  for (const id of ranked) {
    const info = geneInfo[id];
    const c = details[id];
    if (!c) continue;

    const social = SOCIAL_LOOKUP[info.symbol] || null;
    const override = overrides[info.symbol] || null;
    if (social) withContext++;

    genes.push({
      symbol: info.symbol,
      name: info.description,
      chr: c.chr,
      start: c.start,
      end: c.end,
      build: 'hg38',
      publications: pubCounts[id],
      social_tags: social?.social_tags || [],
      category: social?.category || inferCategory(info.description),
      popular_variants: social?.popular_variants || [],
      related_traits: override?.related_trait_ids || [],
      wikipedia_slug: social?.wikipedia_slug || info.symbol,
      // NCBI enrichment
      summary: c.summary || null,
      aliases: [...(info.synonyms || []), ...(c.aliases || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 10),
      exon_count: c.exon_count || null,
      mim_ids: c.mim_ids || [],
      map_location: info.map_location || null,
      // Editorial enrichment (from overrides)
      ...(override ? {
        emoji: override.emoji,
        editorial_description: override.editorial_description,
        what_it_means: override.what_it_means,
        carrier_note: override.carrier_note,
        nonref_interpretation: override.nonref_interpretation,
        clinical_significance: override.clinical_significance,
        actionability: override.actionability,
        fun_fact: override.fun_fact,
      } : {}),
    });
  }

  // Sort by chromosome then position
  const chrOrder = (c) => (c === 'X' ? 23 : c === 'Y' ? 24 : +c);
  genes.sort((a, b) => chrOrder(a.chr) - chrOrder(b.chr) || a.start - b.start);

  const catalog = {
    version: '1.1',
    generated_at: new Date().toISOString(),
    gene_count: genes.length,
    categories: [...new Set(genes.map((g) => g.category))].sort(),
    sources: {
      canonical: 'https://data.asili.dev/gene_catalog.json',
      gene_info: 'https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/Homo_sapiens.gene_info.gz',
      gene2pubmed: 'https://ftp.ncbi.nlm.nih.gov/gene/DATA/gene2pubmed.gz',
      coordinates: 'NCBI Entrez esummary API (hg38)',
      overrides: 'asili-lab/data/gene_overrides.json',
    },
    genes,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(catalog, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const sizeKB = (Buffer.byteLength(JSON.stringify(catalog)) / 1024).toFixed(0);
  console.log(`\n✅ ${OUTPUT_FILE}`);
  console.log(`   ${genes.length} genes (${withContext} with curated context)`);
  console.log(`   ${sizeKB} KB, ${elapsed}s\n`);
}

main().catch((err) => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
