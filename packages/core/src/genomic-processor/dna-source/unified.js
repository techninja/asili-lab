/**
 * Unified DNA Source — Single Parquet file (genotyped + imputed)
 * Uses DuckDB SQL pushdown for scoring — JOIN + GROUP BY runs entirely in DuckDB.
 *
 * Architecture: Single parquet scan → lean _matched table (numeric cols only)
 * → fast in-memory aggregation queries. Top variants re-joins parquet for
 * string columns but only for 4 specific PGS IDs.
 *
 * All JOINs use chr + pos + allele_key columns for allele-aware matching.
 * allele_key = md5(sorted allele pair) truncated to BIGINT, deterministic
 * across all DuckDB runtimes (CLI, Node, Python).
 */

import { DNASource } from './interface.js';
import { createLogger } from '../../utils/log.js';

const log = createLogger('DuckDB');

export class UnifiedDNASource extends DNASource {
  constructor(parquetPath, duckdb) {
    super();
    this.path = parquetPath;
    this.db = duckdb;
    this._dnaLoaded = false;
    this._lastTraitUrl = null;
  }

  async describe() {
    return `UnifiedDNASource(${this.path})`;
  }

  /**
   * Load DNA into an in-memory DuckDB table (once per individual, reused across traits).
   * Requires allele_key column in the parquet (rebuild unified parquet if missing).
   */
  async loadDNA() {
    if (this._dnaLoaded) return;
    await this.db.query(
      `CREATE OR REPLACE TABLE _dna AS SELECT chr, pos, allele_key, variant_id AS user_variant_id, genotype_dosage, imputed, imputation_quality, COALESCE(expected_dosage, 0.0) AS expected_dosage FROM '${this.path}'`
    );
    this._dnaLoaded = true;
  }

  /**
   * Score all PGS for a trait entirely inside DuckDB.
   * Materializes a lean _matched table, then runs aggregation queries in-memory.
   */
  async scoreInDB(traitUrl) {
    await this.loadDNA();
    log.debug('DNA loaded, starting queries...');
    this._lastTraitUrl = traitUrl;

    // Clear stale temp files from previous trait before starting
    await this.db.clearTempDir();

    try {
      return await this._runScoreQueries(traitUrl);
    } catch (err) {
      if (
        err.message?.includes('Could not remove file') ||
        err.message?.includes('temp_storage') ||
        err.message?.includes('Serialization') ||
        err.message?.includes('deserialize')
      ) {
        log.warn(
          'DuckDB temp/serialization error, clearing temp and retrying...'
        );
        await this.db.clearTempDir();
        return await this._runScoreQueries(traitUrl);
      }
      throw err;
    }
  }

  async _runScoreQueries(traitUrl) {
    const scanStart = Date.now();

    // allele_key JOIN ensures only the correct allele at multiallelic sites matches.
    log.debug('Materializing matched variants...');
    // Dosage centering: subtract expected_dosage (2*AF) for imputed variants.
    // expected_dosage stores 2*AF for ALT allele. If effect_allele != ALT (4th field),
    // we flip both dosage and expected. This eliminates population-frequency bias.
    await this.db.query(`
      CREATE OR REPLACE TEMP TABLE _matched AS
      SELECT t.pgs_id, t.chr, t.effect_weight,
             d.genotype_dosage AS dosage, d.imputed,
             t.effect_weight
               * (d.genotype_dosage
                  - CASE WHEN d.imputed THEN d.expected_dosage ELSE 0.0 END)
               * CASE WHEN d.imputed AND d.imputation_quality IS NOT NULL
                      THEN SQRT(d.imputation_quality) ELSE 1.0 END
               AS contribution
      FROM '${traitUrl}' t
      INNER JOIN _dna d ON t.chr = d.chr AND t.pos = d.pos AND t.allele_key = d.allele_key
    `);
    log.debug(`Materialized in ${log.elapsed(scanStart)}`);

    log.debug('Query 1/3: PGS aggregation...');
    const q1Start = Date.now();
    const pgsAggregates = await this.db.query(`
      SELECT
        pgs_id,
        SUM(contribution) AS raw_score,
        COUNT(*) AS matched_variants,
        SUM(CASE WHEN imputed THEN 1 ELSE 0 END) AS imputed_variants,
        SUM(CASE WHEN NOT imputed THEN 1 ELSE 0 END) AS genotyped_variants,
        SUM(CASE WHEN contribution > 0 THEN 1 ELSE 0 END) AS positive_count,
        SUM(CASE WHEN contribution > 0 THEN contribution ELSE 0 END) AS positive_sum,
        SUM(CASE WHEN contribution < 0 THEN 1 ELSE 0 END) AS negative_count,
        SUM(CASE WHEN contribution < 0 THEN contribution ELSE 0 END) AS negative_sum,
        SUM(effect_weight * effect_weight) AS weight_sum_squared,
        MIN(effect_weight) AS weight_min,
        MAX(effect_weight) AS weight_max
      FROM _matched
      GROUP BY pgs_id
    `);
    log.debug(
      `Query 1/3 done: ${pgsAggregates.length} PGS in ${log.elapsed(q1Start)}`
    );

    log.debug('Query 2/3: Chromosome coverage...');
    const q2Start = Date.now();
    const chrCoverage = await this.db.query(`
      SELECT pgs_id, chr, COUNT(*) AS cnt
      FROM _matched GROUP BY pgs_id, chr
    `);
    log.debug(
      `Query 2/3 done: ${chrCoverage.length} rows in ${log.elapsed(q2Start)}`
    );

    log.debug('Query 3/3: Weight histograms...');
    const q3Start = Date.now();
    const weightHist = await this.db.query(`
      SELECT m.pgs_id,
             LEAST(FLOOR((m.effect_weight - agg.w_min) / ((agg.w_max - agg.w_min) / 10.0)) + 1, 10)::INT AS bucket,
             COUNT(*) AS cnt
      FROM _matched m
      INNER JOIN (
        SELECT pgs_id, MIN(effect_weight) AS w_min, MAX(effect_weight) AS w_max
        FROM _matched GROUP BY pgs_id
      ) agg ON m.pgs_id = agg.pgs_id
      WHERE agg.w_min != agg.w_max
      GROUP BY m.pgs_id, bucket
      ORDER BY m.pgs_id, bucket
    `);
    log.debug(
      `Query 3/3 done: ${weightHist.length} rows in ${log.elapsed(q3Start)}`
    );

    // Drop _matched to free memory before top variants
    await this.db.query('DROP TABLE IF EXISTS _matched');

    log.info(`Scoring queries complete in ${log.elapsed(scanStart)}`);
    return { pgsAggregates, chrCoverage, weightHist };
  }

  /**
   * Fetch top 20 variants for specific PGS IDs.
   * Re-joins parquet for string columns but only for the requested PGS.
   * _matched is already dropped so DuckDB has memory headroom.
   */
  async fetchTopVariants(pgsIds) {
    const traitUrl = this._lastTraitUrl;
    if (!traitUrl)
      throw new Error('scoreInDB must be called before fetchTopVariants');

    log.debug(`Top variants: ${pgsIds.length} PGS...`);
    const start = Date.now();
    const all = [];
    for (const pgsId of pgsIds) {
      try {
        const rows = await this.db.query(`
          SELECT t.pgs_id, t.variant_id, t.effect_allele, t.effect_weight,
                 d.genotype_dosage AS dosage, d.imputed, d.user_variant_id,
                 t.effect_weight * d.genotype_dosage AS contribution
          FROM '${traitUrl}' t
          INNER JOIN _dna d ON t.chr = d.chr AND t.pos = d.pos AND t.allele_key = d.allele_key
          WHERE d.genotype_dosage > 0 AND t.pgs_id = '${pgsId}'
          ORDER BY ABS(t.effect_weight * d.genotype_dosage) DESC
          LIMIT 20
        `);
        all.push(...rows);
      } catch (err) {
        if (
          err.message?.includes('Could not remove file') ||
          err.message?.includes('temp_storage')
        ) {
          log.warn(`Temp file error for ${pgsId}, clearing and retrying...`);
          await this.db.clearTempDir();
          const rows = await this.db.query(`
            SELECT t.pgs_id, t.variant_id, t.effect_allele, t.effect_weight,
                   d.genotype_dosage AS dosage, d.imputed, d.user_variant_id,
                   t.effect_weight * d.genotype_dosage AS contribution
            FROM '${traitUrl}' t
            INNER JOIN _dna d ON t.chr = d.chr AND t.pos = d.pos AND t.allele_key = d.allele_key
            WHERE d.genotype_dosage > 0 AND t.pgs_id = '${pgsId}'
            ORDER BY ABS(t.effect_weight * d.genotype_dosage) DESC
            LIMIT 20
          `);
          all.push(...rows);
        } else {
          throw err;
        }
      }
    }
    log.debug(`Top variants done: ${all.length} rows in ${log.elapsed(start)}`);
    return all;
  }

  /**
   * Fetch total variant counts per chromosome for specific PGS IDs.
   * Single parquet scan with no DNA join — lightweight.
   */
  async fetchChrTotals(pgsIds) {
    const traitUrl = this._lastTraitUrl;
    if (!traitUrl || !pgsIds.length) return [];
    const inList = pgsIds.map(id => `'${id}'`).join(',');
    return this.db.query(`
      SELECT pgs_id, chr, COUNT(*) AS cnt
      FROM '${traitUrl}' WHERE pgs_id IN (${inList})
      GROUP BY pgs_id, chr
    `);
  }

  /**
   * Batch-yielding interface for non-scoreInDB callers.
   */
  async *matchVariants(traitUrl, { chunkSize = 15_000_000 } = {}) {
    await this.loadDNA();
    const totalVariants = await this.db.count(traitUrl);

    for (let offset = 0; offset < totalVariants; offset += chunkSize) {
      const matches = await this.db.query(`
        SELECT t.variant_id, t.effect_allele, t.effect_weight, t.pgs_id,
               d.genotype_dosage AS dosage, d.imputed
        FROM (SELECT * FROM '${traitUrl}' LIMIT ${chunkSize} OFFSET ${offset}) t
        INNER JOIN _dna d ON t.chr = d.chr AND t.pos = d.pos AND t.allele_key = d.allele_key
      `);
      yield matches;
    }
  }

  async getVariantCount() {
    return this.db.count(this.path);
  }
}
