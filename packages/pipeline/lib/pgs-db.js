import { getConnection } from './shared-db.js';
import { runMigrations } from './migrate.js';

class PGSMetadataDB {
  constructor() {
    this.initialized = false;
  }

  async getConnection() {
    return await getConnection();
  }

  async init() {
    if (this.initialized) return;
    console.log('[pgs-db] Initializing...');
    await runMigrations();
    console.log('[pgs-db] Migrations complete');
    this.initialized = true;
  }

  async upsertPGS(pgsId, data) {
    await this.init();
    const conn = await this.getConnection();
    const now = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const stmt =
        conn.prepare(`INSERT INTO pgs_scores (pgs_id, weight_type, method_name, norm_mean, norm_sd, variants_number, variants_in_parquet, ld_aware, needs_clumping, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (pgs_id) DO UPDATE SET 
        weight_type=COALESCE(EXCLUDED.weight_type, pgs_scores.weight_type), 
        method_name=COALESCE(EXCLUDED.method_name, pgs_scores.method_name),
        norm_mean=COALESCE(EXCLUDED.norm_mean, pgs_scores.norm_mean), 
        norm_sd=COALESCE(EXCLUDED.norm_sd, pgs_scores.norm_sd), 
        variants_number=COALESCE(EXCLUDED.variants_number, pgs_scores.variants_number), 
        variants_in_parquet=COALESCE(EXCLUDED.variants_in_parquet, pgs_scores.variants_in_parquet), 
        ld_aware=CASE WHEN EXCLUDED.ld_aware IS NOT NULL THEN EXCLUDED.ld_aware ELSE pgs_scores.ld_aware END, 
        needs_clumping=CASE WHEN EXCLUDED.needs_clumping IS NOT NULL THEN EXCLUDED.needs_clumping ELSE pgs_scores.needs_clumping END, 
        last_updated=EXCLUDED.last_updated`);
      stmt.run(
        pgsId,
        data.weight_type ?? null,
        data.method ?? null,
        data.norm_mean ?? null,
        data.norm_sd ?? null,
        data.variants_number ?? null,
        data.variants_in_parquet ?? null,
        data.ld_aware ?? null,
        data.needs_clumping ?? null,
        now,
        err => {
          stmt.finalize();
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async upsertPerformanceMetrics(pgsId, metrics) {
    await this.init();
    const conn = await this.getConnection();
    await new Promise((resolve, reject) => {
      const stmt = conn.prepare('DELETE FROM pgs_performance WHERE pgs_id = ?');
      stmt.run(pgsId, err => {
        stmt.finalize();
        err ? reject(err) : resolve();
      });
    });
    if (!metrics?.all_metrics?.length) return;
    for (const m of metrics.all_metrics) {
      await new Promise((resolve, reject) => {
        const stmt = conn.prepare(
          `INSERT INTO pgs_performance (pgs_id, metric_type, metric_value, ci_lower, ci_upper, sample_size, ancestry) VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        stmt.run(
          pgsId,
          m.type,
          m.value,
          m.ci_lower ?? null,
          m.ci_upper ?? null,
          m.sample_size ?? null,
          m.ancestry ?? null,
          err => {
            stmt.finalize();
            err ? reject(err) : resolve();
          }
        );
      });
    }
  }

  async getPGS(pgsId) {
    await this.init();
    const conn = await this.getConnection();
    return new Promise((resolve, reject) => {
      conn.all(
        'SELECT * FROM pgs_scores WHERE pgs_id = ?',
        [pgsId],
        (err, rows) => (err ? reject(err) : resolve(rows[0]))
      );
    });
  }

  async getBestMetric(pgsId) {
    await this.init();
    const conn = await this.getConnection();
    const metrics = await new Promise((resolve, reject) => {
      conn.all(
        'SELECT * FROM pgs_performance WHERE pgs_id = ? ORDER BY metric_value DESC',
        [pgsId],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    const hierarchy = {
      'C-index': 4,
      'R²': 3,
      AUROC: 3,
      AUC: 3,
      OR: 1,
      HR: 1,
      β: 1
    };
    return metrics.reduce((best, m) => {
      const rank = hierarchy[m.metric_type] || 0;
      const bestRank = best ? hierarchy[best.metric_type] || 0 : 0;
      return rank > bestRank ||
        (rank === bestRank && m.metric_value > (best?.metric_value || 0))
        ? m
        : best;
    }, null);
  }

  async getPGSPerformance(pgsId) {
    await this.init();
    const conn = await this.getConnection();
    return new Promise((resolve, reject) => {
      conn.all(
        'SELECT * FROM pgs_performance WHERE pgs_id = ?',
        [pgsId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
  }

  async close() {
    // Shared connection managed by shared-db.js
  }
}

const pgsDB = new PGSMetadataDB();

export async function upsertPGS(pgsId, data) {
  return pgsDB.upsertPGS(pgsId, data);
}

export async function upsertPerformanceMetrics(pgsId, metrics) {
  return pgsDB.upsertPerformanceMetrics(pgsId, metrics);
}

export async function getPGS(pgsId) {
  return pgsDB.getPGS(pgsId);
}

export async function getBestMetric(pgsId) {
  return pgsDB.getBestMetric(pgsId);
}

export async function getPGSPerformance(pgsId) {
  return pgsDB.getPGSPerformance(pgsId);
}

export async function close() {
  return pgsDB.close();
}
