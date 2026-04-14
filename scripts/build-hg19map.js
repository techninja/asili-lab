/**
 * Build hg19→hg38 liftover parquet packs from UCSC chain file.
 *
 * Stores alignment blocks as ranges: (hg19_start, hg19_end, offset)
 * where offset = hg38_start - hg19_start. The browser remaps a position
 * by finding the block where hg19_start <= pos < hg19_end, then computing
 * pos_hg38 = pos + offset.
 *
 * ~54K blocks total → compresses to a few hundred KB.
 *
 * Browser usage:
 *   SELECT s.*, s.pos + l.hg38_offset AS pos_hg38
 *   FROM _dna_stage s
 *   INNER JOIN 'liftover_chr1.parquet' l
 *     ON s.pos >= l.hg19_start AND s.pos < l.hg19_end
 *   WHERE s.chr = 1
 *
 * Chain format: https://genome.ucsc.edu/goldenPath/help/chain.html
 */

import { createReadStream, mkdirSync, rmSync, writeFileSync, statSync } from 'fs';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import path from 'path';

const CHAIN_FILE = 'tools/liftover/hg19ToHg38.over.chain.gz';
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'data_out';
const OUTPUT_FILE = path.resolve(OUTPUT_DIR, 'hg19map.asili');
const TMP_DIR = OUTPUT_FILE + '_tmp';

const VALID_CHR = new Set([
  'chr1','chr2','chr3','chr4','chr5','chr6','chr7','chr8','chr9','chr10',
  'chr11','chr12','chr13','chr14','chr15','chr16','chr17','chr18','chr19',
  'chr20','chr21','chr22','chrX','chrY'
]);

const CHR_LABEL = {
  chrX: 'X', chrY: 'Y',
  ...Object.fromEntries(
    Array.from({ length: 22 }, (_, i) => [`chr${i + 1}`, String(i + 1)])
  )
};

/**
 * Parse chain file into alignment block ranges per chromosome.
 * Returns Map<chrName, Array<{hg19_start, hg19_end, offset}>>
 */
async function parseChainBlocks(chainPath) {
  const chrBlocks = new Map();
  for (const chr of VALID_CHR) chrBlocks.set(chr, []);

  const rl = createInterface({
    input: createReadStream(chainPath).pipe(createGunzip()),
    crlfDelay: Infinity
  });

  let chain = null;

  for await (const line of rl) {
    if (line.startsWith('chain')) {
      const p = line.split(/\s+/);
      const tName = p[2], tStrand = p[4], tStart = +p[5];
      const qName = p[7], qStrand = p[9], qStart = +p[10];

      if (tName === qName && tStrand === '+' && qStrand === '+' && VALID_CHR.has(tName)) {
        chain = { chr: tName, tPos: tStart, qPos: qStart };
      } else {
        chain = null;
      }
      continue;
    }

    if (!chain || !line.trim()) continue;

    const p = line.split('\t');
    const size = +p[0];
    const { chr, tPos, qPos } = chain;

    // One block: hg19 range [tPos, tPos+size), offset to get hg38
    chrBlocks.get(chr).push({
      hg19_start: tPos,
      hg19_end: tPos + size,
      offset: qPos - tPos
    });

    if (p.length === 3) {
      chain.tPos = tPos + size + (+p[1]);
      chain.qPos = qPos + size + (+p[2]);
    } else {
      chain = null;
    }
  }

  return chrBlocks;
}

export async function buildHg19Map() {
  console.log('\n🗺️  Building hg19→hg38 liftover map...\n');
  const startTime = Date.now();

  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('📖 Parsing chain file...');
  const chrBlocks = await parseChainBlocks(CHAIN_FILE);

  let totalBlocks = 0;
  for (const blocks of chrBlocks.values()) totalBlocks += blocks.length;
  console.log(`   ${totalBlocks.toLocaleString()} alignment blocks across ${chrBlocks.size} chromosomes\n`);

  console.log('📦 Converting to parquet...');
  const chromosomes = {};

  const sortedChrs = [...chrBlocks.keys()].sort((a, b) => {
    const na = a === 'chrX' ? 23 : a === 'chrY' ? 24 : +a.replace('chr', '');
    const nb = b === 'chrX' ? 23 : b === 'chrY' ? 24 : +b.replace('chr', '');
    return na - nb;
  });

  for (const chr of sortedChrs) {
    const blocks = chrBlocks.get(chr);
    if (!blocks.length) continue;
    const label = CHR_LABEL[chr];
    if (!label) continue;

    const csvPath = path.join(TMP_DIR, `chr${label}.csv`);
    const parquetPath = path.join(TMP_DIR, `chr${label}.parquet`);

    // Write CSV
    let csv = 'hg19_start,hg19_end,hg38_offset\n';
    for (const b of blocks) {
      csv += `${b.hg19_start},${b.hg19_end},${b.offset}\n`;
    }
    writeFileSync(csvPath, csv);

    execSync(
      `duckdb -c "COPY (SELECT CAST(hg19_start AS INTEGER) AS hg19_start, CAST(hg19_end AS INTEGER) AS hg19_end, CAST(hg38_offset AS INTEGER) AS hg38_offset FROM read_csv('${csvPath}', header=true) ORDER BY hg19_start) TO '${parquetPath}' (FORMAT PARQUET, COMPRESSION ZSTD)"`,
      { maxBuffer: 50 * 1024 * 1024 }
    );

    const sizeKB = (statSync(parquetPath).size / 1e3).toFixed(0);
    console.log(`   chr${label}: ${blocks.length.toLocaleString()} blocks (${sizeKB} KB)`);

    chromosomes[label] = { file: `chr${label}.parquet`, mappings: blocks.length };
  }

  // Manifest
  writeFileSync(path.join(TMP_DIR, 'manifest.json'), JSON.stringify({
    format: 'asili-liftover-v1',
    source: 'hg19',
    target: 'hg38',
    chainFile: 'hg19ToHg38.over.chain.gz',
    totalMappings: totalBlocks,
    schema: {
      description: 'Alignment block ranges. Each row covers a contiguous region where hg19 maps linearly to hg38.',
      columns: {
        hg19_start: 'INTEGER — inclusive start of hg19 range',
        hg19_end: 'INTEGER — exclusive end of hg19 range',
        hg38_offset: 'INTEGER — signed offset: pos_hg38 = pos_hg19 + hg38_offset'
      },
      sortedBy: 'hg19_start',
      usage: "SELECT s.*, s.pos + l.hg38_offset AS pos_hg38 FROM _dna_stage s INNER JOIN 'liftover_chrN.parquet' l ON s.pos >= l.hg19_start AND s.pos < l.hg19_end"
    },
    chromosomes,
    createdAt: new Date().toISOString()
  }, null, 2));

  // Bundle tar
  const tarFiles = ['manifest.json', ...Object.values(chromosomes).map(c => c.file)];
  execSync(`tar cf "${OUTPUT_FILE}" ${tarFiles.join(' ')}`, { cwd: TMP_DIR });
  rmSync(TMP_DIR, { recursive: true, force: true });

  const sizeKB = (statSync(OUTPUT_FILE).size / 1e3).toFixed(0);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ ${OUTPUT_FILE} (${sizeKB} KB — ${totalBlocks.toLocaleString()} blocks, ${elapsed}s)\n`);
}
