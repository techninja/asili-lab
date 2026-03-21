/**
 * DuckDB Server Adapter — Node.js native DuckDB
 * Wraps callback-based API into promises with a consistent interface.
 */

import { cpus } from 'os';
import { rm, mkdir } from 'fs/promises';

export class DuckDBServerAdapter {
  constructor() {
    this.db = null;
    this.conn = null;
  }

  async initialize() {
    if (this.db) return;

    const duckdb = await import('duckdb');
    this.db = new duckdb.default.Database(':memory:');
    this.conn = this.db.connect();

    await this.query('INSTALL httpfs');
    await this.query('LOAD httpfs');
    await this.query('SET http_timeout=60000');
    await this.query(`SET threads=${cpus().length}`);
    await this.query("SET memory_limit='6GB'");
    await this.query("SET temp_directory='/tmp/duckdb_swap'");
    await this.query('SET preserve_insertion_order=false');
    await this.query('SET enable_http_metadata_cache=true');
  }

  async query(sql) {
    return new Promise((resolve, reject) => {
      this.conn.all(sql, (err, result) => {
        if (err) reject(err);
        else resolve(result || []);
      });
    });
  }

  async count(tableOrUrl) {
    const result = await this.query(
      `SELECT COUNT(*) as count FROM '${tableOrUrl}'`
    );
    return Number(result[0]?.count || 0);
  }

  async fileExists(path) {
    try {
      await this.query(`SELECT 1 FROM read_parquet('${path}') LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }

  async clearTempDir() {
    // Reset DuckDB's temp directory so it invalidates internal block references,
    // then recreate the directory fresh.
    try {
      await this.query("SET temp_directory=''");
      await rm('/tmp/duckdb_swap', { recursive: true, force: true });
      await mkdir('/tmp/duckdb_swap', { recursive: true });
      await this.query("SET temp_directory='/tmp/duckdb_swap'");
    } catch {
      /* best effort */
    }
  }

  async cleanup() {
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
