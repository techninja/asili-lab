import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import duckdb from 'duckdb';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR =
  process.env.OUTPUT_DIR || path.join(__dirname, '..', '..', '..', 'data_out');
const PACKS_DIR = path.join(OUTPUT_DIR, 'packs');

export { OUTPUT_DIR, PACKS_DIR };

// --- Persistent DuckDB connection helper ---

export function openDuckDB(dbPath) {
  const db = new duckdb.Database(dbPath);
  const conn = db.connect();
  const memoryLimit = process.env.DUCKDB_MEMORY_LIMIT || '8GB';
  const tempDir = process.env.LARGE_TMP || '/tmp';
  const threads =
    process.env.DUCKDB_THREADS || Math.max(4, Math.floor(os.cpus().length / 2));

  conn.run(`PRAGMA memory_limit='${memoryLimit}'`);
  conn.run(`PRAGMA temp_directory='${tempDir}'`);
  conn.run(`PRAGMA threads=${threads}`);

  return { db, conn };
}

/** Run a query, return rows */
export function query(conn, sql) {
  return new Promise((resolve, reject) => {
    conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

/** Run a statement (no result needed) */
export function exec(conn, sql) {
  return new Promise((resolve, reject) => {
    conn.exec(sql, err => (err ? reject(err) : resolve()));
  });
}

/** Close a { db, conn } pair */
export function closeDuckDB({ db, conn }) {
  try { conn.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
}

// --- File utilities ---

export async function needsUpdate(traitName, _config) {
  const safeFileName = traitName.replace(':', '_');
  const filePath = path.join(PACKS_DIR, `${safeFileName}_hg38.parquet`);
  try {
    await fs.stat(filePath);
    await validateParquetFile(filePath);
    console.log(`    ✓ ${filePath} exists and valid, skipping`);
    return false;
  } catch {
    return true;
  }
}

export async function countVariantsInFile(filePath) {
  const { createReadStream } = await import('fs');
  const { createGunzip } = await import('zlib');

  return new Promise((resolve, reject) => {
    let count = 0;
    let inHeader = true;
    let tail = '';

    createReadStream(filePath)
      .pipe(createGunzip())
      .on('data', chunk => {
        const str = tail + chunk.toString('utf-8');
        const lines = str.split('\n');
        tail = lines.pop();
        for (const line of lines) {
          if (inHeader && (line.startsWith('#') || !line.trim())) continue;
          if (inHeader) { inHeader = false; continue; }
          if (line.trim()) count++;
        }
      })
      .on('end', () => resolve(count))
      .on('error', err => {
        if (err.message.includes('unexpected end of file')) {
          fs.unlink(filePath).catch(() => {});
          reject(new Error(`Corrupted file removed: ${filePath}`));
        } else {
          reject(err);
        }
      });
  });
}

export async function prepareFileForProcessing(filePath) {
  // Only extract header columns — DuckDB reads the .gz directly via
  // read_csv(..., comment='#'), so no full decompression needed.
  const { createReadStream } = await import('fs');
  const { createGunzip } = await import('zlib');
  const { createInterface } = await import('readline');

  const columns = await new Promise((resolve, reject) => {
    let found = false;
    const stream = createReadStream(filePath);
    const gunzip = stream.pipe(createGunzip());
    stream.on('error', reject);
    gunzip.on('error', reject);
    const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
    rl.on('line', line => {
      if (found) return;
      if (line.startsWith('#') || !line.trim()) return;
      found = true;
      resolve(line.split('\t'));
      rl.close();
      stream.destroy();
    });
    rl.on('close', () => { if (!found) resolve(null); });
    rl.on('error', reject);
  });

  if (!columns) throw new Error('No header found in file');

  // Return the .gz path — DuckDB handles decompression natively
  return { columns, dataOnlyPath: filePath, dataLineCount: -1 };
}

export function createStandardizedExportQuery(tableName, outputPath) {
  // allele_key: hash of sorted allele pair from variant_id (chr:pos:A:B).
  // Sorting ensures A:G and G:A produce the same key, enabling allele-aware
  // joins without string parsing at query time. This eliminates spurious
  // cross-product matches at multiallelic sites.
  return `
    CREATE OR REPLACE TABLE ${tableName}_standardized AS
    SELECT 
        COALESCE(variant_id, '') as variant_id,
        COALESCE(effect_allele, '') as effect_allele,
        COALESCE(effect_weight, 0.0) as effect_weight,
        COALESCE(pgs_id, '') as pgs_id,
        CASE SPLIT_PART(COALESCE(variant_id, ''), ':', 1)
          WHEN 'X' THEN 23::TINYINT WHEN 'Y' THEN 24::TINYINT WHEN 'MT' THEN 25::TINYINT
          ELSE TRY_CAST(SPLIT_PART(COALESCE(variant_id, ''), ':', 1) AS TINYINT)
        END AS chr,
        TRY_CAST(SPLIT_PART(COALESCE(variant_id, ''), ':', 2) AS INTEGER) AS pos,
        ('0x' || md5(LEAST(SPLIT_PART(COALESCE(variant_id,''),':',3), SPLIT_PART(COALESCE(variant_id,''),':',4))
          || ':' ||
          GREATEST(SPLIT_PART(COALESCE(variant_id,''),':',3), SPLIT_PART(COALESCE(variant_id,''),':',4))
        )[:15])::BIGINT AS allele_key
    FROM ${tableName}
    WHERE variant_id IS NOT NULL AND variant_id != ''
      AND effect_allele IS NOT NULL AND effect_allele != ''
      AND effect_weight IS NOT NULL
      AND NOT contains(SPLIT_PART(variant_id, ':', 1), '_');
    
    COPY (SELECT variant_id, effect_allele, effect_weight, pgs_id, chr, pos, allele_key
    FROM ${tableName}_standardized ORDER BY chr, pos, allele_key) 
    TO '${outputPath}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `;
}

export async function validateParquetFile(filePath) {
  const stats = await fs.stat(filePath);
  if (stats.size < 100) throw new Error('File too small');

  const db = new duckdb.Database(':memory:');
  const conn = db.connect();
  try {
    const rows = await query(conn, `SELECT COUNT(*) as count FROM '${filePath}'`);
    const variantCount = Number(rows[0]?.count ?? 0);
    return { size: stats.size, variantCount, fileName: path.basename(filePath) };
  } finally {
    conn.close();
    db.close();
  }
}
