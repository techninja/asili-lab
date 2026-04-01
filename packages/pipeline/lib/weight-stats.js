import duckdb from 'duckdb';

export function terminateWorkerPool() {
  // No-op — kept for API compatibility
}

export async function calculateWeightStats(pgsId, pgsApiClient) {
  const filePath = await pgsApiClient.getPGSFile(pgsId);
  return calculateWeightStatsFromFile(pgsId, filePath);
}

export async function calculateWeightStatsFromFile(pgsId, filePath) {
  const db = new duckdb.Database(':memory:');
  const conn = db.connect();

  try {
    // Detect weight column — dosage format uses dosage_1_weight instead of effect_weight
    const described = await new Promise((resolve, reject) => {
      conn.all(`DESCRIBE SELECT * FROM read_csv('${filePath}', delim='\t', header=true, comment='#', all_varchar=true)`,
        (err, rows) => err ? reject(err) : resolve(rows));
    });
    const cols = described.map(r => r.column_name);
    const weightCol = cols.includes('effect_weight') ? 'effect_weight'
      : cols.includes('dosage_1_weight') ? 'dosage_1_weight'
      : cols.includes('weight') ? 'weight' : null;
    if (!weightCol) return null;

    const hasAF = cols.includes('allelefrequency_effect') || cols.includes('effect_allele_frequency');
    if (!hasAF) {
      // Without real allele frequencies, af=0.5 produces garbage normalization.
      // Return null so the TOPMed refstats pipeline provides proper stats later.
      return null;
    }
    const afCol = cols.includes('allelefrequency_effect') ? 'allelefrequency_effect' : 'effect_allele_frequency';
    const afExpr = `COALESCE(TRY_CAST("${afCol}" AS DOUBLE), 0.5)`;

    const rows = await new Promise((resolve, reject) => {
      conn.all(`
        SELECT
          SUM(w * 2.0 * af) as mean_sum,
          SUM(w * w * 2.0 * af * (1.0 - af)) as var_sum,
          COUNT(*) as cnt
        FROM (
          SELECT TRY_CAST("${weightCol}" AS DOUBLE) as w, ${afExpr} as af
          FROM read_csv('${filePath}', delim='\t', header=true, comment='#', all_varchar=true, ignore_errors=true)
          WHERE "${weightCol}" IS NOT NULL AND "${weightCol}" != ''
        )
      `, (err, rows) => err ? reject(err) : resolve(rows));
    });

    const { mean_sum, var_sum, cnt } = rows[0];
    if (!cnt || cnt === 0) return null;
    return { mean: mean_sum, sd: Math.sqrt(var_sum), count: Number(cnt) };
  } catch (error) {
    console.error(`Error calculating weight stats for ${pgsId}:`, error.message);
    return null;
  } finally {
    conn.close();
    db.close();
  }
}
