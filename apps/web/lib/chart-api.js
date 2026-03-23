import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let db = null;

function getDB() {
  if (db) return db;
  const duckdb = require('duckdb');
  db = new duckdb.Database(':memory:');
  const conn = db.connect();
  conn.exec(`
    ATTACH '/app/data_out/risk_scores.db' AS rs (READ_ONLY);
    ATTACH '/app/data_out/trait_manifest.db' AS tm (READ_ONLY);
  `);
  conn.close();
  return db;
}

function query(sql) {
  return new Promise((resolve, reject) => {
    const conn = getDB().connect();
    conn.all(sql, (err, rows) => {
      conn.close();
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

export function registerChartAPI(app) {
  // Full summary: per-individual, per-trait, with best-PGS genotyped/imputed breakdown
  app.get('/api/charts/summary', async (_req, res) => {
    try {
      const rows = await query(`
        SELECT
          t.individual_id,
          t.trait_id,
          tm.traits.name AS trait_name,
          tm.traits.categories,
          tm.traits.unit,
          ROUND(t.value, 3) AS value,
          ROUND(t.overall_z_score, 4) AS z_score,
          ROUND(t.overall_percentile, 2) AS percentile,
          t.best_pgs_id,
          ROUND(t.best_pgs_performance, 4) AS best_r2,
          t.total_matched_variants AS matched,
          t.total_expected_variants AS expected,
          bp.genotyped_variants AS best_genotyped,
          bp.imputed_variants AS best_imputed,
          bp.matched_variants AS best_matched,
          ROUND(bp.quality_score, 1) AS best_quality
        FROM rs.trait_results t
        JOIN tm.traits ON t.trait_id = tm.traits.trait_id
        LEFT JOIN rs.pgs_results bp
          ON t.individual_id = bp.individual_id
          AND t.trait_id = bp.trait_id
          AND t.best_pgs_id = bp.pgs_id
        ORDER BY t.individual_id, tm.traits.categories, tm.traits.name
      `);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
