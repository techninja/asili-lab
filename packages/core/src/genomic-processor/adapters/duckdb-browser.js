/**
 * DuckDB Browser Adapter — DuckDB WASM
 * Wraps @duckdb/duckdb-wasm with Arrow → plain Object conversion.
 */

export class DuckDBBrowserAdapter {
  constructor() {
    this.db = null;
    this.conn = null;
  }

  async initialize() {
    if (this.db) return;

    const duckdb = await import('/deps/duckdb.js');
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const worker = await duckdb.createWorker(bundle.mainWorker);
    const logger = new duckdb.VoidLogger();

    this.db = new duckdb.AsyncDuckDB(logger, worker);
    await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    this.conn = await this.db.connect();

    await this.conn.query('INSTALL httpfs');
    await this.conn.query('LOAD httpfs');
    await this.conn.query('SET http_timeout=30000');
  }

  async query(sql) {
    const result = await this.conn.query(sql);
    return result.toArray().map(row => {
      // Convert Arrow proxy to plain object
      const obj = {};
      for (const key of Object.keys(row)) {
        obj[key] = row[key];
      }
      return obj;
    });
  }

  async count(tableOrUrl) {
    const result = await this.conn.query(
      `SELECT COUNT(*) as count FROM '${tableOrUrl}'`
    );
    return Number(result.toArray()[0].count);
  }

  async fileExists(path) {
    try {
      await this.conn.query(`SELECT 1 FROM '${path}' LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }

  async cleanup() {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
    if (this.db) {
      await this.db.terminate();
      this.db = null;
    }
  }
}
