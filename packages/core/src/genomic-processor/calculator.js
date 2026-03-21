/**
 * Shared risk calculation logic for both browser and server
 * Ensures consistent PGS calculations across platforms
 *
 * NORMALIZATION FIX (from REFACTOR_GENOMIC_PROCESSOR.md):
 * - Never scale empirical mean/SD by coverage
 * - Coverage affects quality score, not z-score
 * - variants_in_parquet is the canonical denominator
 */

import { Debug } from '../utils/debug.js';

const MIN_VARIANT_THRESHOLD = 8;
const MIN_COVERAGE_FOR_NORMALIZATION = 0.05;

export class SharedRiskCalculator {
  constructor(normalizationParams = {}) {
    this.pgsBreakdown = new Map();
    this.pgsDetails = new Map();
    this.totalMatches = 0;
    this.totalScore = 0;
    this.normalizationParams = normalizationParams;
    this.imputedCount = 0;
  }

  initializePGS(pgsId, metadata = {}) {
    if (!this.pgsBreakdown.has(pgsId)) {
      this.pgsBreakdown.set(pgsId, {
        positive: 0, negative: 0,
        positiveSum: 0, negativeSum: 0,
        total: 0,
        weightSumSquared: 0,
        weightMin: Infinity, weightMax: -Infinity,
        weightHistogram: new Float64Array(10),
        chromosomeCoverage: {},
        genotypedVariants: 0, imputedVariants: 0
      });

      this.pgsDetails.set(pgsId, {
        score: 0,
        matchedVariants: 0,
        genotypedVariants: 0,
        imputedVariants: 0,
        metadata: {
          ...metadata,
          mean: metadata.norm_mean ?? metadata.mean,
          std: metadata.norm_sd ?? metadata.std,
          weight_type: metadata.weight_type,
          method: metadata.method,
          variants_number: metadata.variants_number
        },
        topVariants: [],
        _topMinAbs: 0,
        _topMinIdx: 0
      });
    }
  }

  addTopVariant(pgsId, variantData) {
    const details = this.pgsDetails.get(pgsId);
    if (!details) return;

    if (details.topVariants.length < 20) {
      details.topVariants.push(variantData);
    } else {
      const minIndex = details.topVariants.reduce(
        (minIdx, curr, idx, arr) =>
          Math.abs(curr.contribution) < Math.abs(arr[minIdx].contribution) ? idx : minIdx,
        0
      );
      if (Math.abs(variantData.contribution) > Math.abs(details.topVariants[minIndex].contribution)) {
        details.topVariants[minIndex] = variantData;
      }
    }
  }

  /**
   * Quality score formula (unchanged from original)
   */
  static calculatePGSQualityScore(matchedVariants, totalVariants, performanceMetric, hasNormalization = true, zScore = null, genotypedVariants = 0) {
    if (matchedVariants === 0 || !totalVariants) return 0;

    const coverage = Math.min(matchedVariants / totalVariants, 1);
    const genotypedRatio = matchedVariants > 0 ? genotypedVariants / matchedVariants : 0;
    const r2 = performanceMetric || 0.05;

    let coveragePenalty = 1.0;
    if (coverage < 0.05) coveragePenalty = Math.pow(coverage / 0.05, 2);
    else if (coverage < 0.20) coveragePenalty = Math.sqrt(coverage / 0.20);

    const performanceScore = r2 * 35 * coveragePenalty;
    const dataReliabilityScore = genotypedRatio * 15;
    const coverageScore = coverage * 10;
    const sampleSizeRatio = Math.max(matchedVariants / MIN_VARIANT_THRESHOLD, 1);
    const sampleScore = Math.min(Math.log10(sampleSizeRatio) / 3.1, 1) * 10;
    const normalizationScore = hasNormalization ? 10 : 5;

    let signalScore = 0;
    if (zScore !== null && zScore !== undefined && !isNaN(zScore)) {
      const absZ = Math.abs(zScore);
      // Cap signal at 3σ, and penalize extreme z-scores (>5σ) as likely bad stats
      if (absZ > 5) {
        signalScore = 0; // Extreme z = bad normalization, not real signal
      } else {
        signalScore = Math.min(absZ / 3, 1) * 20;
      }
    }

    return Math.round((performanceScore + dataReliabilityScore + coverageScore + sampleScore + normalizationScore + signalScore) * 10000) / 10000;
  }

  static getQualityScoreBreakdown(matchedVariants, totalVariants, performanceMetric, hasNormalization = true, zScore = null, genotypedVariants = 0) {
    if (matchedVariants === 0 || !totalVariants) {
      return { total: 0, components: [], explanation: 'No variants matched' };
    }

    const coverage = Math.min(matchedVariants / totalVariants, 1);
    const r2 = performanceMetric || 0.05;
    const genotypedRatio = matchedVariants > 0 ? genotypedVariants / matchedVariants : 0;
    const imputedVariants = matchedVariants - genotypedVariants;

    let coveragePenalty = 1.0;
    let penaltyDescription = 'No penalty';
    if (coverage < 0.05) {
      coveragePenalty = Math.pow(coverage / 0.05, 2);
      penaltyDescription = `Severe penalty: ${(coveragePenalty * 100).toFixed(1)}% of R² (coverage < 5%)`;
    } else if (coverage < 0.20) {
      coveragePenalty = Math.sqrt(coverage / 0.20);
      penaltyDescription = `Moderate penalty: ${(coveragePenalty * 100).toFixed(1)}% of R² (coverage < 20%)`;
    }

    const performanceScore = r2 * 35 * coveragePenalty;
    const dataReliabilityScore = genotypedRatio * 15;
    const coverageScore = coverage * 10;
    const sampleScore = Math.min(Math.log10(Math.max(matchedVariants / MIN_VARIANT_THRESHOLD, 1)) / 3.1, 1) * 10;
    const normalizationScore = hasNormalization ? 10 : 5;

    let signalScore = 0;
    let signalDescription = 'No z-score available';
    if (zScore !== null && zScore !== undefined && !isNaN(zScore)) {
      const absZ = Math.abs(zScore);
      if (absZ > 5) {
        signalScore = 0;
        signalDescription = `Extreme z-score (${absZ.toFixed(1)}σ) — likely bad normalization stats, signal zeroed`;
      } else {
        signalScore = Math.min(absZ / 3, 1) * 20;
        signalDescription = absZ >= 3 ? `Extreme signal: ${absZ.toFixed(1)}σ from mean (capped at 3σ)` :
                            absZ >= 2 ? `Strong signal: ${absZ.toFixed(1)}σ from mean` :
                            absZ >= 1 ? `Moderate signal: ${absZ.toFixed(1)}σ from mean` :
                            `Weak signal: ${absZ.toFixed(1)}σ from mean (near average)`;
      }
    }

    const total = performanceScore + dataReliabilityScore + coverageScore + sampleScore + normalizationScore + signalScore;

    return {
      total: Math.round(total * 100) / 100,
      coveragePenalty: Math.round(coveragePenalty * 1000) / 1000,
      components: [
        { name: 'Predictive Accuracy (R²)', value: r2, score: Math.round(performanceScore * 10) / 10, maxScore: 35, weight: '35%', description: `R²=${(r2 * 100).toFixed(1)}% × ${penaltyDescription}` },
        { name: 'Data Reliability', value: genotypedRatio, score: Math.round(dataReliabilityScore * 10) / 10, maxScore: 15, weight: '15%', description: `${genotypedVariants.toLocaleString()} genotyped / ${imputedVariants.toLocaleString()} imputed (${(genotypedRatio * 100).toFixed(1)}% real DNA)` },
        { name: 'Coverage', value: coverage, score: Math.round(coverageScore * 10) / 10, maxScore: 10, weight: '10%', description: `${(coverage * 100).toFixed(1)}% of PGS variants found` },
        { name: 'Sample Size', value: matchedVariants, score: Math.round(sampleScore * 10) / 10, maxScore: 10, weight: '10%', description: `${matchedVariants.toLocaleString()} variants matched (log scale)` },
        { name: 'Normalization', value: hasNormalization ? 1 : 0.5, score: normalizationScore, maxScore: 10, weight: '10%', description: hasNormalization ? 'Percentile available' : 'No percentile data' },
        { name: 'Signal Strength', value: zScore !== null ? Math.abs(zScore) : 0, score: Math.round(signalScore * 10) / 10, maxScore: 20, weight: '20%', description: signalDescription }
      ],
      explanation: total >= 70 ? 'Excellent predictive power and highly informative' :
                   total >= 50 ? 'Good reliability and informative' :
                   total >= 30 ? 'Moderate predictive value' :
                   'Limited predictive value'
    };
  }

  /**
   * Finalize results with FIXED normalization
   *
   * KEY FIX: Never scale mean/SD by coverage.
   * Coverage affects confidence (quality score), not the z-score itself.
   */
  async finalize(traitType = 'disease_risk', _unit = null, phenotypeMean = null, phenotypeSd = null, pgsPerformanceMetrics = {}) {
    // Initialize any PGS from normalizationParams that weren't matched
    for (const pgsId in this.normalizationParams) {
      this.initializePGS(pgsId, this.normalizationParams[pgsId]);
    }

    let totalWeightedZScore = 0;
    let totalWeight = 0;

    for (const [pgsId, details] of this.pgsDetails.entries()) {
      const metadata = details.metadata || {};
      const normParams = this.normalizationParams[pgsId] || {};
      const breakdown = this.pgsBreakdown.get(pgsId);

      let mean = metadata.mean ?? metadata.norm_mean ?? normParams.norm_mean;
      let sd = metadata.std ?? metadata.norm_sd ?? normParams.norm_sd;
      const performanceWeight = metadata.performance_weight ?? normParams.performance_weight ?? 0.05;

      // FIXED: Use metadata.variants_number (parquet count from scorer) as canonical denominator
      // breakdown.total = matched variants, metadata.variants_number = total in parquet
      const totalVariants = metadata.variants_number || breakdown?.total || details.matchedVariants || 0;
      const coverage = totalVariants > 0 ? details.matchedVariants / totalVariants : 0;

      const hasEmpiricalData = sd !== undefined && sd > 0;
      const sufficientCoverage = coverage >= MIN_COVERAGE_FOR_NORMALIZATION;

      // NORMALIZATION FIX: Never scale mean/SD by coverage.
      // The gnomAD mean and SD describe the full-PGS distribution.
      // A partial sum from matched variants is a different random variable.
      // Coverage affects CONFIDENCE (quality score), not the z-score itself.
      //
      // INCOMPATIBLE STATS DETECTION: When coverage is partial, the raw score
      // is a partial sum but mean/SD describe the full sum. If the raw score
      // is wildly different from the mean relative to SD, the empirical stats
      // are clearly incompatible — fall back to theoretical normalization.
      let useEmpirical = hasEmpiricalData && sufficientCoverage;

      if (useEmpirical && coverage < 0.80 && mean !== undefined && mean !== 0) {
        const naiveZ = Math.abs((details.score - mean) / sd);
        if (naiveZ > 20) {
          // Raw score is >20σ from mean — empirical stats are for a different distribution
          useEmpirical = false;
          Debug.log(1, 'SharedRiskCalculator', `PGS ${pgsId}: Empirical stats incompatible (naiveZ=${naiveZ.toFixed(0)}σ, coverage=${(coverage * 100).toFixed(1)}%) — falling back to theoretical`);
        }
      }

      if (useEmpirical) {
        Debug.log(1, 'SharedRiskCalculator', `PGS ${pgsId}: Using unscaled empirical normalization (coverage ${(coverage * 100).toFixed(1)}%, mean=${mean?.toFixed(4)}, sd=${sd?.toFixed(4)})`);
      } else if (breakdown?.total > 0) {
        mean = 0;
        sd = SharedRiskCalculator.estimateTheoreticalSD(breakdown.weightSumSquared, breakdown.total);
        const reason = !hasEmpiricalData ? 'no empirical data'
          : !sufficientCoverage ? `low coverage (${(coverage * 100).toFixed(1)}%)`
          : 'incompatible empirical stats';
        Debug.log(1, 'SharedRiskCalculator', `PGS ${pgsId}: Using theoretical normalization due to ${reason} (mean=0, sd=${sd.toFixed(4)})`);
      }

      details.confidence = SharedRiskCalculator.calculateConfidence(details.matchedVariants);
      details.insufficientData = details.matchedVariants < MIN_VARIANT_THRESHOLD;
      details.insufficientEmpiricalData = !hasEmpiricalData || !sufficientCoverage;
      details.insufficientCoverage = !sufficientCoverage;
      details.coverage = coverage;
      details.performanceMetric = performanceWeight;
      details.normMean = mean;
      details.normSd = sd;
      details.normalizationScaled = false; // FIXED: never scaled

      if (mean !== undefined && sd !== undefined && sd > 0 && details.matchedVariants > 0) {
        details.zScore = SharedRiskCalculator.calculateZScore(details.score, { mean, sd });
        details.percentile = SharedRiskCalculator.calculatePercentile(details.zScore);

        details.qualityScore = SharedRiskCalculator.calculatePGSQualityScore(
          details.matchedVariants, totalVariants, performanceWeight,
          !details.insufficientEmpiricalData, details.zScore, details.genotypedVariants
        );

        if (traitType === 'quantitative' && phenotypeMean !== null && phenotypeSd !== null) {
          const r2 = pgsPerformanceMetrics[pgsId]?.r2 || performanceWeight;
          details.value = phenotypeMean + (details.zScore * Math.sqrt(r2) * phenotypeSd);
          details.r2 = r2;
        }

        if (!details.insufficientData && !details.insufficientEmpiricalData) {
          totalWeightedZScore += details.zScore * performanceWeight;
          totalWeight += performanceWeight;
        }
      } else {
        details.zScore = null;
        details.percentile = null;
        details.value = null;
        details.qualityScore = SharedRiskCalculator.calculatePGSQualityScore(
          details.matchedVariants, totalVariants, performanceWeight,
          !details.insufficientEmpiricalData, null, details.genotypedVariants
        );
      }

      if (details.topVariants) {
        const variantSd = sd || 1;
        details.topVariants.forEach(v => { v.standardizedContribution = v.contribution / variantSd; });
        details.topVariants.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
      }
    }

    // Compute weight buckets and clean up
    for (const [, breakdown] of this.pgsBreakdown.entries()) {
      if (breakdown.total > 0 && breakdown.weightMin !== Infinity) {
        breakdown.weightBuckets = this.computeWeightBuckets(breakdown.weightMin, breakdown.weightMax, breakdown.total, breakdown._histCounts);
      } else {
        breakdown.weightBuckets = [];
      }
      delete breakdown.weightSumSquared;
      delete breakdown.weightMin;
      delete breakdown.weightMax;
      delete breakdown.weightHistogram;
      delete breakdown._histCounts;
    }

    // Clean up internal tracking fields from pgsDetails
    for (const [, details] of this.pgsDetails.entries()) {
      delete details._topMinAbs;
      delete details._topMinIdx;
    }

    // Select best PGS by quality score
    let bestPGS = null;
    let bestQualityScore = 0;
    for (const [pgsId, details] of this.pgsDetails.entries()) {
      if (!details.insufficientData && details.qualityScore > bestQualityScore) {
        bestQualityScore = details.qualityScore;
        bestPGS = pgsId;
      }
    }

    // Fallback: if all PGS are insufficient, pick the best available anyway
    // (user gets a result with low confidence rather than nothing)
    if (!bestPGS && this.pgsDetails.size > 0) {
      for (const [pgsId, details] of this.pgsDetails.entries()) {
        if (details.qualityScore > bestQualityScore && details.zScore !== null) {
          bestQualityScore = details.qualityScore;
          bestPGS = pgsId;
        }
      }
    }

    const bestDetails = bestPGS ? this.pgsDetails.get(bestPGS) : null;
    const overallZScore = bestDetails?.zScore ?? (totalWeight > 0 ? totalWeightedZScore / totalWeight : null);
    const overallPercentile = bestDetails?.percentile ?? (overallZScore ? SharedRiskCalculator.calculatePercentile(overallZScore) : null);
    const overallConfidence = bestDetails?.confidence ?? 'medium';
    const overallValue = bestDetails?.value ?? null;

    const result = {
      zScore: overallZScore,
      percentile: overallPercentile,
      confidence: overallConfidence,
      bestPGS,
      bestPGSPerformance: bestDetails?.performanceMetric || 0,
      bestPGSQualityScore: bestQualityScore,
      totalMatches: this.totalMatches,
      pgsBreakdown: Object.fromEntries(this.pgsBreakdown),
      pgsDetails: Object.fromEntries(this.pgsDetails)
    };

    if (traitType === 'quantitative' && overallValue !== null) {
      result.value = overallValue;
    } else if (traitType === 'quantitative' && phenotypeMean !== null && phenotypeSd !== null && overallZScore !== null) {
      const bestR2 = bestDetails?.r2 || 0.05;
      result.value = phenotypeMean + (overallZScore * Math.sqrt(bestR2) * phenotypeSd);
    }

    return result;
  }

  static estimateTheoreticalSD(weightSumSquared, count) {
    if (!count || count === 0) return 1.0;
    return Math.sqrt(weightSumSquared * 0.5);
  }

  static calculateConfidence(matchedVariants) {
    if (matchedVariants === 0) return 'none';
    if (matchedVariants < MIN_VARIANT_THRESHOLD) return 'insufficient';
    if (matchedVariants < 10) return 'low';
    if (matchedVariants < 100) return 'medium';
    return 'high';
  }

  static calculateZScore(rawScore, empiricalStats) {
    if (!empiricalStats || empiricalStats.mean === undefined || empiricalStats.mean === null || !empiricalStats.sd) return null;
    return (rawScore - empiricalStats.mean) / empiricalStats.sd;
  }

  static calculatePercentile(zScore) {
    if (zScore === null || zScore === undefined) return null;
    const erf = (x) => {
      const sign = x >= 0 ? 1 : -1;
      x = Math.abs(x);
      const t = 1.0 / (1.0 + 0.3275911 * x);
      const y = 1.0 - (((((1.061405429 * t + -1.453152027) * t) + 1.421413741) * t + -0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
      return sign * y;
    };
    return 0.5 * (1 + erf(zScore / Math.sqrt(2))) * 100;
  }

  computeWeightBuckets(min, max, totalCount, histCounts = null) {
    if (totalCount === 0) return [];
    const range = max - min;
    if (range === 0) return [{ min, max, count: totalCount, label: min.toExponential(2) }];

    const numBuckets = 10;
    const bucketSize = range / numBuckets;
    return Array.from({ length: numBuckets }, (_, i) => {
      const bMin = min + i * bucketSize;
      const bMax = min + (i + 1) * bucketSize;
      const absMax = Math.max(Math.abs(bMin), Math.abs(bMax));
      const label = absMax >= 1 ? `${bMin.toFixed(2)} to ${bMax.toFixed(2)}` :
                    absMax >= 0.01 ? `${bMin.toFixed(3)} to ${bMax.toFixed(3)}` :
                    `${bMin.toExponential(1)} to ${bMax.toExponential(1)}`;
      // WIDTH_BUCKET returns 1-indexed buckets
      const count = histCounts ? (histCounts.get(i + 1) || 0) : 0;
      return { min: bMin, max: bMax, count, label };
    });
  }

  cleanup() {
    this.pgsBreakdown.clear();
    this.pgsDetails.clear();
    this.totalMatches = 0;
    this.totalScore = 0;
  }
}
