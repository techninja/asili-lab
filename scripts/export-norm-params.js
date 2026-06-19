#!/usr/bin/env node
/**
 * Export pgs_norm_params.json from the trait manifest database.
 *
 * Reads norm_mean, norm_sd, and variants_number from the pgs_scores table
 * and writes the compact {PGS_ID: {m, s, n}} format consumed by the browser.
 *
 * This is the bridge between:
 *   - calc-pgs-refstats (writes to trait_manifest.db)
 *   - the browser app (reads pgs_norm_params.json)
 *
 * Usage:
 *   node scripts/export-norm-params.js
 */
import '../packages/pipeline/lib/env.js';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import duckdb from 'duckdb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const MANIFEST_DB = path.join(ROOT, 'data_out', 'trait_manifest.db');
const OUTPUT_PATH = path.join(ROOT, 'data_out', 'pgs_norm_params.json');

function dbQuery(conn, sql) {
  return new Promise((resolve, reject) => {
    conn.all(sql, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function main() {
  if (!existsSync(MANIFEST_DB)) {
    console.error('❌ trait_manifest.db not found. Run pnpm traits refresh first.');
    process.exit(1);
  }

  const db = new duckdb.Database(MANIFEST_DB);
  const conn = db.connect();

  const rows = await dbQuery(conn, `
    SELECT pgs_id, norm_mean, norm_sd, variants_number
    FROM pgs_scores
    WHERE norm_mean IS NOT NULL AND norm_sd IS NOT NULL AND norm_sd > 0
  `);

  // Preserve existing extra fields (d, ancestry) if the file already exists
  let existing = {};
  if (existsSync(OUTPUT_PATH)) {
    try {
      existing = JSON.parse(await readFile(OUTPUT_PATH, 'utf8'));
    } catch { /* start fresh */ }
  }

  const output = {};
  for (const row of rows) {
    const prev = existing[row.pgs_id] || {};
    output[row.pgs_id] = {
      m: row.norm_mean,
      s: row.norm_sd,
      n: row.variants_number || prev.n || 0,
      // Preserve histogram and ancestry data if present
      ...(prev.d ? { d: prev.d } : {}),
      ...(prev.ancestry ? { ancestry: prev.ancestry } : {}),
      // Preserve tiered norms (raw/imputed) from empirical subsampling
      ...(prev.tiers ? { tiers: prev.tiers } : {}),
    };
  }

  await writeFile(OUTPUT_PATH, JSON.stringify(output, (_, v) =>
    typeof v === 'bigint' ? Number(v) : v
  ));

  conn.close();
  db.close();

  const sizeKB = Math.round((await readFile(OUTPUT_PATH)).length / 1024);
  console.log(`\n✅ Exported ${Object.keys(output).length} PGS norm params (${sizeKB} KB)`);
  console.log(`   Output: ${OUTPUT_PATH}\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
