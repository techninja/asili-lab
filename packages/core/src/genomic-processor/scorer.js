/**
 * PGS Scorer — The ONE scoring loop
 *
 * This is the single place where PGS scores are accumulated.
 * It consumes the matchVariants async iterator from any DNA source.
 * Variant matching and PGS accumulation logic exists exactly once here.
 */

import { SharedRiskCalculator } from './calculator.js';
import { createLogger } from '../utils/log.js';

const log = createLogger('Scorer');

export class PGSScorer {
  constructor(normalizationParams = {}) {
    this.calculator = new SharedRiskCalculator(normalizationParams);
  }

  /**
   * Score via SQL pushdown — accepts pre-aggregated results from UnifiedDNASource.scoreInDB().
   * No per-variant JS loop. DuckDB does the JOIN + GROUP BY entirely in native code.
   *
   * @param {{pgsAggregates: Array, chrCoverage: Array, topVariants: Array}} dbResults
   * @param {Map<string, number>} pgsVariantCounts
   * @returns {SharedRiskCalculator}
   */
  loadFromDB(dbResults, pgsVariantCounts) {
    const calc = this.calculator;
    const { pgsAggregates, chrCoverage, weightHist } = dbResults;

    // Build chromosome coverage lookup: pgsId -> { chr: count }
    const chrMap = new Map();
    for (const row of chrCoverage) {
      const pgsId = row.pgs_id;
      if (!chrMap.has(pgsId)) chrMap.set(pgsId, {});
      chrMap.get(pgsId)[String(row.chr)] = Number(row.cnt);
    }

    // Build weight histogram lookup: pgsId -> Map<bucket, count>
    const histMap = new Map();
    if (weightHist) {
      for (const row of weightHist) {
        const pgsId = row.pgs_id;
        if (!histMap.has(pgsId)) histMap.set(pgsId, new Map());
        histMap.get(pgsId).set(Number(row.bucket), Number(row.cnt));
      }
    }

    // Populate calculator from aggregated rows
    for (const row of pgsAggregates) {
      const pgsId = row.pgs_id;
      const matched = Number(row.matched_variants);
      const imputed = Number(row.imputed_variants);
      const genotyped = Number(row.genotyped_variants);

      calc.initializePGS(pgsId, {
        variants_number: pgsVariantCounts.get(pgsId) || 0
      });

      const breakdown = calc.pgsBreakdown.get(pgsId);
      const details = calc.pgsDetails.get(pgsId);

      details.score = Number(row.raw_score);
      details.matchedVariants = matched;
      details.genotypedVariants = genotyped;
      details.imputedVariants = imputed;

      breakdown.positive = Number(row.positive_count);
      breakdown.positiveSum = Number(row.positive_sum);
      breakdown.negative = Number(row.negative_count);
      breakdown.negativeSum = Number(row.negative_sum);
      breakdown.total = matched;
      breakdown.weightSumSquared = Number(row.weight_sum_squared);
      breakdown.weightMin = Number(row.weight_min);
      breakdown.weightMax = Number(row.weight_max);
      breakdown.genotypedVariants = genotyped;
      breakdown.imputedVariants = imputed;
      breakdown.chromosomeCoverage = chrMap.get(pgsId) || {};
      breakdown._histCounts = histMap.get(pgsId) || null;

      details.topVariants = [];

      calc.totalScore += details.score;
      calc.totalMatches += matched;
      calc.imputedCount += imputed;
    }

    return calc;
  }

  /**
   * Load top variants from a separate query (called after quality scores are known).
   */
  /**
   * Load total variant counts per chromosome onto breakdowns.
   */
  loadChrTotals(rows) {
    const calc = this.calculator;
    for (const row of rows) {
      const breakdown = calc.pgsBreakdown.get(row.pgs_id);
      if (!breakdown) continue;
      if (!breakdown.chrTotals) breakdown.chrTotals = {};
      breakdown.chrTotals[String(row.chr)] = Number(row.cnt);
    }
  }

  loadTopVariants(topVariantRows) {
    const calc = this.calculator;
    for (const row of topVariantRows) {
      const pgsId = row.pgs_id;
      const details = calc.pgsDetails.get(pgsId);
      if (!details) continue;
      const isImputed = row.imputed === true || row.imputed === 1;
      const dosage = Number(row.dosage);
      const parts = row.user_variant_id?.split(':');
      details.topVariants.push({
        rsid: row.variant_id,
        effect_allele: row.effect_allele,
        effect_weight: Number(row.effect_weight),
        userGenotype:
          parts?.length >= 4
            ? `${parts[2]}${parts[3]}`
            : isImputed
              ? `~${dosage.toFixed(1)}`
              : `${dosage.toFixed(0)}`,
        chromosome: row.variant_id?.split(':')[0] || 'unknown',
        contribution: Number(row.contribution),
        imputed: isImputed,
        dosage,
        quality: 1.0
      });
    }
  }

  /**
   * Score all PGS for a trait using matched variants from any DNA source.
   * Fallback path for non-unified sources (GenotypedDNASource).
   *
   * @param {import('./dna-source/interface.js').DNASource} dnaSource
   * @param {string} traitUrl - Path/URL to trait Parquet file
   * @param {Map<string, number>} pgsVariantCounts - total variants per PGS in parquet (for quality score)
   * @param {Function} [onProgress] - (message, percent) => void
   * @returns {Promise<SharedRiskCalculator>} Calculator with accumulated state (pre-finalize)
   */
  async score(dnaSource, traitUrl, pgsVariantCounts, onProgress) {
    const startTime = Date.now();
    const calc = this.calculator;

    for await (const batch of dnaSource.matchVariants(traitUrl)) {
      const len = batch.length;
      for (let i = 0; i < len; i++) {
        const m = batch[i];
        const pgsId = m.pgs_id;
        const effectWeight = +m.effect_weight || 0;
        const dosage = m.dosage ?? m.genotype_dosage;
        const isImputed = m.imputed === true || m.imputed === 1;
        const chr = m.variant_id.split(':', 1)[0] || 'unknown';

        if (!calc.pgsDetails.has(pgsId)) {
          calc.initializePGS(pgsId, {
            variants_number: pgsVariantCounts.get(pgsId) || 0
          });
        }

        const contribution = effectWeight * dosage;
        const breakdown = calc.pgsBreakdown.get(pgsId);
        const details = calc.pgsDetails.get(pgsId);

        if (contribution > 0) {
          breakdown.positive++;
          breakdown.positiveSum += contribution;
        } else if (contribution < 0) {
          breakdown.negative++;
          breakdown.negativeSum += contribution;
        }

        breakdown.total++;
        breakdown.weightSumSquared += effectWeight * effectWeight;
        if (effectWeight < breakdown.weightMin)
          breakdown.weightMin = effectWeight;
        if (effectWeight > breakdown.weightMax)
          breakdown.weightMax = effectWeight;
        breakdown.chromosomeCoverage[chr] =
          (breakdown.chromosomeCoverage[chr] || 0) + 1;

        details.score += contribution;
        details.matchedVariants++;
        calc.totalScore += contribution;
        calc.totalMatches++;

        if (isImputed) {
          calc.imputedCount++;
          breakdown.imputedVariants++;
          details.imputedVariants++;
        } else {
          breakdown.genotypedVariants++;
          details.genotypedVariants++;
        }

        // Only allocate top-variant object when it might make the top-20
        const absContrib = Math.abs(contribution);
        const topVars = details.topVariants;
        if (topVars.length < 20 || absContrib > details._topMinAbs) {
          const variantData = {
            rsid: m.variant_id,
            effect_allele: m.effect_allele,
            effect_weight: effectWeight,
            userGenotype: isImputed
              ? `imputed(${dosage.toFixed(2)})`
              : `genotyped(${dosage.toFixed(0)})`,
            chromosome: chr,
            contribution,
            imputed: isImputed,
            quality: 1.0
          };

          if (topVars.length < 20) {
            topVars.push(variantData);
            if (topVars.length === 20) {
              // Compute initial min threshold
              details._topMinAbs = Infinity;
              for (let j = 0; j < 20; j++) {
                const a = Math.abs(topVars[j].contribution);
                if (a < details._topMinAbs) {
                  details._topMinAbs = a;
                  details._topMinIdx = j;
                }
              }
            }
          } else {
            topVars[details._topMinIdx] = variantData;
            // Recompute min
            details._topMinAbs = Infinity;
            for (let j = 0; j < 20; j++) {
              const a = Math.abs(topVars[j].contribution);
              if (a < details._topMinAbs) {
                details._topMinAbs = a;
                details._topMinIdx = j;
              }
            }
          }
        }
      }

      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0) {
        const rate = Math.round(calc.totalMatches / elapsed);
        onProgress?.(
          `${calc.totalMatches.toLocaleString()} matches (${rate.toLocaleString()}/sec)`,
          null
        );
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.info(
      `Scoring complete in ${elapsed}s | ${calc.totalMatches.toLocaleString()} matches | ${Math.round(calc.totalMatches / elapsed).toLocaleString()}/sec`
    );

    return calc;
  }

  /**
   * Finalize scores — delegates to calculator with normalization fix
   */
  async finalize(
    traitType,
    unit,
    phenotypeMean,
    phenotypeSd,
    pgsPerformanceMetrics
  ) {
    return this.calculator.finalize(
      traitType,
      unit,
      phenotypeMean,
      phenotypeSd,
      pgsPerformanceMetrics
    );
  }
}
