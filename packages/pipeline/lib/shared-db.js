import duckdb from 'duckdb';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use /output in Docker, data_out locally
const OUTPUT_DIR = process.env.OUTPUT_DIR ||
  (fs.existsSync('/output') ? '/output' : path.join(path.resolve(__dirname, '../../..'), 'data_out'));
const DB_PATH = path.join(OUTPUT_DIR, 'trait_manifest.db');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  console.log(`Creating output directory: ${OUTPUT_DIR}`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Singleton database instance
let db = null;
let conn = null;

export async function getConnection() {
  if (!db) {
    try {
      db = new duckdb.Database(DB_PATH);
    } catch (error) {
      const errMsg = error.message || '';
      if (errMsg.includes('lock') || errMsg.includes('locked')) {
        console.error('\n❌ Database is locked by another process!');
        console.error('💡 Are you running any other servers or have DB connections open?');
        console.error('   Please close all connections and retry the pipeline.\n');
        throw new Error('Database locked - close other connections and retry');
      }
      if (errMsg.includes('Serialization Error') || errMsg.includes('deserialize')) {
        console.error('\n❌ Database version mismatch!');
        console.error('💡 The database was created with a different DuckDB version.');
        console.error('   Please rebuild the pipeline container: docker compose build pipeline\n');
        throw new Error('Database version mismatch - rebuild pipeline container');
      }
      throw error;
    }
  }
  if (!conn) {
    conn = db.connect();
  }
  return conn;
}

export function closeConnection() {
  if (conn) {
    conn.close();
    conn = null;
  }
  if (db) {
    db.close();
    db = null;
  }
}
