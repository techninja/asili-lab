/**
 * Scan all parquet files and populate pgs_scores table with ALL PGS found
 */

import fs from 'fs';
import path from 'path';
import duckdb from 'duckdb';
import { upsertPGS } from './lib/pgs-db.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/output';
const PACKS_DIR = path.join(OUTPUT_DIR, 'packs');

export default async function scanParquetFiles(singleTraitId = null) {
  if (singleTraitId) {
    console.log(`🔍 Scanning parquet file for trait ${singleTraitId}...`);
  } else {
    console.log('🔍 Scanning parquet files for all PGS IDs...');
  }
  
  const db = new duckdb.Database(':memory:');
  const conn = db.connect();
  
  // Install and load httpfs for parquet support
  await new Promise((resolve, reject) => {
    conn.run('INSTALL httpfs', (err) => {
      if (err) reject(err);
      else conn.run('LOAD httpfs', (err2) => {
        if (err2) reject(err2);
        else resolve();
      });
    });
  });
  
  let parquetFiles = fs.readdirSync(PACKS_DIR).filter(f => f.endsWith('.parquet'));
  
  if (singleTraitId) {
    const safeTraitId = singleTraitId.replace(':', '_');
    parquetFiles = parquetFiles.filter(f => f.startsWith(safeTraitId));
    if (parquetFiles.length === 0) {
      console.log(`  No parquet file found for ${singleTraitId}`);
      return;
    }
  }
  
  console.log(`Found ${parquetFiles.length} parquet file(s)`);
  
  const allPGS = new Map();
  
  for (const file of parquetFiles) {
    const filePath = path.join(PACKS_DIR, file);
    console.log(`  Scanning ${file}...`);
    
    try {
      const pgsData = await new Promise((resolve, reject) => {
        conn.all(`
          SELECT 
            pgs_id,
            COUNT(*) as variant_count,
            FIRST(effect_weight) as sample_weight
          FROM '${filePath}'
          GROUP BY pgs_id
        `, (err, rows) => err ? reject(err) : resolve(rows));
      });
      
      for (const row of pgsData) {
        if (!allPGS.has(row.pgs_id)) {
          allPGS.set(row.pgs_id, {
            variants_in_parquet: Number(row.variant_count)
          });
        } else {
          // PGS exists in multiple packs, sum the variant counts
          const existing = allPGS.get(row.pgs_id);
          existing.variants_in_parquet = (existing.variants_in_parquet || 0) + Number(row.variant_count);
        }
      }
      
      console.log(`    Found ${pgsData.length} unique PGS in ${file}`);
    } catch (err) {
      console.error(`    Error scanning ${file}:`, err.message);
    }
  }
  
  conn.close();
  db.close();
  
  console.log(`\n✓ Found ${allPGS.size} unique PGS across all parquet files`);
  
  // Now populate pgs_scores table
  console.log('\n📝 Populating pgs_scores table...');
  let inserted = 0;
  let updated = 0;
  
  for (const [pgsId, metadata] of allPGS.entries()) {
    try {
      await upsertPGS(pgsId, metadata);
      inserted++;
      if (inserted % 100 === 0) {
        console.log(`  Processed ${inserted}/${allPGS.size} PGS...`);
      }
    } catch (err) {
      console.error(`  Error upserting ${pgsId}:`, err.message);
    }
  }
  
  console.log(`\n✓ Populated pgs_scores with ${inserted} PGS entries`);
}
