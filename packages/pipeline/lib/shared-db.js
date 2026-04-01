import duckdb from 'duckdb';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OUTPUT_DIR =
  process.env.OUTPUT_DIR ||
  (fs.existsSync('/output')
    ? '/output'
    : path.join(path.resolve(__dirname, '../../..'), 'data_out'));
const DB_PATH = path.join(OUTPUT_DIR, 'trait_manifest.db');

if (!fs.existsSync(OUTPUT_DIR)) {
  console.log(`Creating output directory: ${OUTPUT_DIR}`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Singleton database instance — ALL access to trait_manifest.db goes through here.
// DuckDB does not support concurrent writers; a serialized queue prevents corruption.
let db = null;
let conn = null;
let writeQueue = Promise.resolve();

export async function getConnection() {
  if (!db) {
    console.log('[shared-db] Creating new database instance');
    try {
      db = new duckdb.Database(DB_PATH);
      console.log('[shared-db] Database opened successfully');
    } catch (error) {
      const errMsg = error.message || '';
      if (errMsg.includes('lock') || errMsg.includes('locked')) {
        console.error('\n❌ Database is locked by another process!');
        console.error(
          '💡 Are you running any other servers or have DB connections open?'
        );
        console.error(
          '   Please close all connections and retry the pipeline.\n'
        );
        throw new Error('Database locked - close other connections and retry');
      }
      if (
        errMsg.includes('Serialization Error') ||
        errMsg.includes('deserialize')
      ) {
        console.error('\n❌ Database version mismatch!');
        console.error(
          '💡 The database was created with a different DuckDB version.'
        );
        console.error(
          '   Please rebuild the pipeline container: docker compose build pipeline\n'
        );
        throw new Error(
          'Database version mismatch - rebuild pipeline container'
        );
      }
      throw error;
    }
  }
  if (!conn) {
    console.log('[shared-db] Creating new connection');
    conn = db.connect();
    console.log('[shared-db] Connection ready');
  }
  return conn;
}

/**
 * Execute a write operation through the serialized queue.
 * Prevents concurrent writes from corrupting DuckDB's internal state.
 *
 * @param {function(conn): Promise} fn - async function receiving the connection
 * @returns {Promise} result of fn
 */
export function serializedWrite(fn) {
  const task = writeQueue.then(async () => {
    const c = await getConnection();
    return fn(c);
  });
  // Chain regardless of success/failure so the queue keeps moving
  writeQueue = task.catch(() => {});
  return task;
}

export function closeConnection() {
  console.log('[shared-db] closeConnection called');
  if (conn) {
    conn.close();
    conn = null;
  }
  if (db) {
    db.close();
    db = null;
  }
}

export { DB_PATH, OUTPUT_DIR };
