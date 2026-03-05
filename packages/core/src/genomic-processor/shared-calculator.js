/**
 * Shared risk calculation logic for both browser and server
 * Ensures consistent PGS calculations across platforms
 */

import { Debug } from '../utils/debug.js';

// Minimum matched variants required for reliable PGS calculation
const MIN_VARIANT_THRESHOLD = 8;
const MIN_EMPIRICAL_SD = 0.1; // Minimum SD for reliable normalization

export class SharedRiskCalculator {
  constructor(normalizationParams = {}) {
    this.pgsBreakdown = new Map();
    this.pgsDetails = new Map();
    this.totalMatches = 0;
    this.totalScore = 0;
    this.normalizationParams = normalizationParams;
  }

  /**
   * Create DNA lookup maps for efficient variant matching
   */
  createDNALookup(userDNA) {
    const dnaLookup = new Map();
    
    userDNA.forEach(variant => {
      // Store the full variant object for lookup
      // Add rsID lookup
      if (variant.rsid) {
        dnaLookup.set(variant.rsid, variant);
      }
      
      // Add position-based lookups (chr:pos format)
      if (variant.chromosome && variant.position) {
        dnaLookup.set(`${variant.chromosome}:${variant.position}`, variant);
      }
      
      // Add full variant ID lookups (chr:pos:allele1:allele2 format)
      if (variant.chromosome && variant.position && variant.allele1 && variant.allele2) {
        dnaLookup.set(`${variant.chromosome}:${variant.position}:${variant.allele1}:${variant.allele2}`, variant);
        dnaLookup.set(`${variant.chromosome}:${variant.position}:${variant.allele2}:${variant.allele1}`, variant);
      }
    });
    
    return dnaLookup;
  }

  /**
   * Initialize a PGS if it doesn't exist
   */
  initializePGS(pgsId, metadata = {}) {
    if (!this.pgsBreakdown.has(pgsId)) {
      this.pgsBreakdown.set(pgsId, {
        positive: 0,
        negative: 0,
        positiveSum: 0,
        negativeSum: 0,
        total: 0,
        weightDistribution: [], // Track all weights for dynamic bucketing
        chromosomeCoverage: {} // Track matched variants per chromosome
      });

      this.pgsDetails.set(pgsId, {
        score: 0,
        matchedVariants: 0,
        metadata: {
          ...metadata,
          mean: metadata.norm_mean ?? metadata.mean,
          std: metadata.norm_sd ?? metadata.std,
          weight_type: metadata.weight_type,
          method: metadata.method,
          variants_number: metadata.variants_number
        },
        topVariants: []
      });
    }
  }

  /**
   * Process a single variant and update PGS scores
   */
  processVariant(variantRow, dnaLookup, pgsMetadata = {}) {
    // Try multiple lookup strategies like the browser does
    let variant = dnaLookup.get(variantRow.variant_id);
    
    // If direct lookup fails, try position-based lookup
    if (!variant && variantRow.variant_id.includes(':')) {
      const parts = variantRow.variant_id.split(':');
      if (parts.length >= 2) {
        const posKey = `${parts[0]}:${parts[1]}`;
        variant = dnaLookup.get(posKey);
      }
    }
    
    if (!variant) return false;

    const pgsId = variantRow.pgs_id;
    const effectWeight = parseFloat(variantRow.effect_weight) || 0;
    
    // Count how many copies of the effect allele the user has
    let effectAlleleCount = 0;
    if (variant.allele1 === variantRow.effect_allele) effectAlleleCount++;
    if (variant.allele2 === variantRow.effect_allele) effectAlleleCount++;
    
    // Only count as a match and add to PGS scores if user has effect alleles
    if (effectAlleleCount > 0) {
      // Initialize PGS if needed
      this.initializePGS(pgsId, pgsMetadata[pgsId] || {});
      
      // Calculate the contribution (effect weight * number of effect alleles)
      const contribution = effectWeight * effectAlleleCount;
      
      const breakdown = this.pgsBreakdown.get(pgsId);
      const details = this.pgsDetails.get(pgsId);
      
      // Count positive and negative contributions
      if (contribution > 0) {
        breakdown.positive += 1;
        breakdown.positiveSum += contribution;
      } else if (contribution < 0) {
        breakdown.negative += 1;
        breakdown.negativeSum += contribution;
      }
      
      breakdown.total += 1;
      breakdown.weightDistribution.push(effectWeight);
      
      // Track chromosome coverage
      const chr = variant.chromosome?.toString() || 'unknown';
      breakdown.chromosomeCoverage[chr] = (breakdown.chromosomeCoverage[chr] || 0) + 1;
      details.score += contribution;
      details.matchedVariants += 1;
      this.totalScore += contribution;
      this.totalMatches++; // Only count matches that contribute
      
      // Store top variants for detailed view
      this.addTopVariant(pgsId, {
        rsid: variantRow.variant_id,
        effect_allele: variantRow.effect_allele,
        effect_weight: effectWeight,
        userGenotype: `${variant.allele1}${variant.allele2}`,
        chromosome: variant.chromosome,
        contribution: contribution
      });
      
      return true;
    }
    
    return false; // No contribution
  }

  /**
   * Add variant to top variants list, maintaining only top 20 by actual contribution
   */
  addTopVariant(pgsId, variantData) {
    const details = this.pgsDetails.get(pgsId);
    if (!details) return;
    
    if (details.topVariants.length < 20) {
      details.topVariants.push(variantData);
    } else {
      // Replace lowest impact variant if this one is higher
      const minIndex = details.topVariants.reduce(
        (minIdx, curr, idx, arr) =>
          Math.abs(curr.contribution) < Math.abs(arr[minIdx].contribution)
            ? idx
            : minIdx,
        0
      );
      
      if (Math.abs(variantData.contribution) > Math.abs(details.topVariants[minIndex].contribution)) {
        details.topVariants[minIndex] = variantData;
      }
    }
  }

  /**
   * Calculate unified quality score for a PGS (0-100)
   * 
   * Formula: (R² × 50) + (Coverage × 30) + (Confidence × 20)
   * 
   * Where:
   * - R² (Performance): 0-1, how well the PGS predicts the trait (50% weight)
   * - Coverage: 0-1, percentage of variants matched (30% weight)
   * - Confidence: 0-1, based on matched variant count (20% weight)
   *   - <8 variants: 0.1 (insufficient data)
   *   - <10 variants: 0.5 (low confidence)
   *   - <100 variants: 0.8 (medium confidence)
   *   - ≥100 variants: 1.0 (high confidence)
   * 
   * Example: PGS with R²=0.15, 80% coverage, 50 variants matched:
   *   Score = (0.15 × 50) + (0.80 × 30) + (0.8 × 20) = 7.5 + 24 + 16 = 47.5
   * 
   * @param {number} matchedVariants - Number of variants matched in user's DNA
   * @param {number} totalVariants - Total variants in the PGS
   * @param {number} performanceMetric - R² value (0-1)
   * @returns {number} Quality score (0-100)
   */
  static calculatePGSQualityScore(matchedVariants, totalVariants, performanceMetric) {
    if (matchedVariants === 0 || !totalVariants) return 0;
    
    // Coverage: percentage of variants matched (0-1)
    const coverage = Math.min(matchedVariants / totalVariants, 1);
    
    // Performance: R² value (0-1), default to 0.05 if missing
    const performance = performanceMetric || 0.05;
    
    // Confidence penalty: reduce score if below minimum threshold
    let confidenceFactor = 1.0;
    if (matchedVariants < MIN_VARIANT_THRESHOLD) {
      confidenceFactor = 0.1; // Heavy penalty for insufficient data
    } else if (matchedVariants < 10) {
      confidenceFactor = 0.5; // Moderate penalty for low confidence
    } else if (matchedVariants < 100) {
      confidenceFactor = 0.8; // Small penalty for medium confidence
    }
    
    // Weighted combination: 50% performance, 30% coverage, 20% confidence
    const score = (performance * 50) + (coverage * 30) + (confidenceFactor * 20);
    
    return Math.round(score * 100) / 100; // Round to 2 decimals
  }

  /**
   * Finalize results and return formatted output with proper normalization
   */
  async finalize(traitType = 'disease_risk', unit = null, phenotypeMean = null, phenotypeSd = null, pgsPerformanceMetrics = {}) {
    // Initialize any PGS from normalizationParams that weren't matched
    for (const pgsId in this.normalizationParams) {
      this.initializePGS(pgsId, this.normalizationParams[pgsId]);
    }
    
    // Compute dynamic weight distribution buckets for each PGS
    for (const [pgsId, breakdown] of this.pgsBreakdown.entries()) {
      Debug.log(1, 'SharedRiskCalculator', `PGS ${pgsId}: ${breakdown.weightDistribution?.length || 0} weights collected`);
      if (breakdown.weightDistribution && breakdown.weightDistribution.length > 0) {
        breakdown.weightBuckets = this.computeWeightBuckets(breakdown.weightDistribution);
        Debug.log(1, 'SharedRiskCalculator', `PGS ${pgsId}: Generated ${breakdown.weightBuckets.length} buckets`);
        delete breakdown.weightDistribution; // Remove raw data to save space
      } else {
        breakdown.weightBuckets = [];
      }
      // Keep chromosomeCoverage for storage
    }
    
    // Calculate z-scores and quality scores for each PGS
    let bestPGS = null;
    let bestQualityScore = 0;
    let totalWeightedZScore = 0;
    let totalWeight = 0;
    
    for (const [pgsId, details] of this.pgsDetails.entries()) {
      const metadata = details.metadata || {};
      const normParams = this.normalizationParams[pgsId] || {};
      const breakdown = this.pgsBreakdown.get(pgsId);
      
      const mean = metadata.mean ?? metadata.norm_mean ?? normParams.norm_mean;
      const sd = metadata.std ?? metadata.norm_sd ?? normParams.norm_sd;
      const performanceWeight = metadata.performance_weight ?? normParams.performance_weight ?? 0.05;
      const totalVariants = metadata.variants_number || breakdown?.total || details.matchedVariants;
      
      details.confidence = SharedRiskCalculator.calculateConfidence(details.matchedVariants);
      details.insufficientData = details.matchedVariants < MIN_VARIANT_THRESHOLD;
      details.insufficientEmpiricalData = !sd || sd < MIN_EMPIRICAL_SD;
      details.performanceMetric = performanceWeight;
      details.normMean = mean;
      details.normSd = sd;
      
      // Calculate unified quality score
      details.qualityScore = SharedRiskCalculator.calculatePGSQualityScore(
        details.matchedVariants,
        totalVariants,
        performanceWeight
      );
      
      if (mean !== undefined && sd !== undefined && sd >= MIN_EMPIRICAL_SD && details.matchedVariants > 0) {
        details.zScore = SharedRiskCalculator.calculateZScore(details.score, { mean, sd });
        details.percentile = SharedRiskCalculator.calculatePercentile(details.zScore);
        
        // For quantitative traits, scale genetic z-score by sqrt(R²) to get phenotype z-score
        if (traitType === 'quantitative' && phenotypeMean !== null && phenotypeSd !== null) {
          const r2 = pgsPerformanceMetrics[pgsId]?.r2 || performanceWeight;
          const phenotypeZScore = details.zScore * Math.sqrt(r2);
          details.value = phenotypeMean + (phenotypeZScore * phenotypeSd);
          details.r2 = r2;
        }
        
        // Find best PGS by quality score
        if (details.qualityScore > bestQualityScore && !details.insufficientData && !details.insufficientEmpiricalData) {
          bestQualityScore = details.qualityScore;
          bestPGS = pgsId;
        }
        
        if (!details.insufficientData && !details.insufficientEmpiricalData) {
          totalWeightedZScore += details.zScore * performanceWeight;
          totalWeight += performanceWeight;
        }
      } else {
        details.zScore = null;
        details.percentile = null;
        details.value = null;
      }
      
      // Sort and standardize top variants
      if (details.topVariants) {
        const variantSd = sd || 1;
        details.topVariants.forEach(v => {
          v.standardizedContribution = v.contribution / variantSd;
        });
        details.topVariants.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
      }
    }
    
    // Overall scores from best PGS or weighted average
    if (!bestPGS && this.pgsDetails.size > 0) {
      // Fallback: find any PGS with valid data
      for (const [pgsId, details] of this.pgsDetails.entries()) {
        if (!details.insufficientData && !details.insufficientEmpiricalData && details.zScore !== null) {
          bestPGS = pgsId;
          bestQualityScore = details.qualityScore || 0;
          break;
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
    
    // Add value for quantitative traits
    if (traitType === 'quantitative' && overallValue !== null) {
      result.value = overallValue;
    } else if (traitType === 'quantitative' && phenotypeMean !== null && phenotypeSd !== null && overallZScore !== null) {
      // Calculate from overall z-score with R² scaling
      const bestR2 = bestDetails?.r2 || 0.05;
      const phenotypeZScore = overallZScore * Math.sqrt(bestR2);
      result.value = phenotypeMean + (phenotypeZScore * phenotypeSd);
    }
    
    return result;
  }

  /**
   * Calculate confidence level based on number of matched variants
   */
  static calculateConfidence(matchedVariants) {
    if (matchedVariants === 0) return 'none';
    if (matchedVariants < MIN_VARIANT_THRESHOLD) return 'insufficient';
    if (matchedVariants < 10) return 'low';
    if (matchedVariants < 100) return 'medium';
    return 'high';
  }

  /**
   * Calculate z-score from raw score using empirical distribution
   */
  static calculateZScore(rawScore, empiricalStats) {
    if (!empiricalStats || !empiricalStats.mean || !empiricalStats.sd) return null;
    return (rawScore - empiricalStats.mean) / empiricalStats.sd;
  }

  /**
   * Calculate percentile from z-score using normal CDF approximation
   */
  static calculatePercentile(zScore) {
    if (zScore === null || zScore === undefined) return null;
    
    // Approximation of error function for normal CDF
    const erf = (x) => {
      const sign = x >= 0 ? 1 : -1;
      x = Math.abs(x);
      const a1 = 0.254829592;
      const a2 = -0.284496736;
      const a3 = 1.421413741;
      const a4 = -1.453152027;
      const a5 = 1.061405429;
      const p = 0.3275911;
      const t = 1.0 / (1.0 + p * x);
      const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
      return sign * y;
    };
    
    return 0.5 * (1 + erf(zScore / Math.sqrt(2))) * 100;
  }

  /**
   * Compute dynamic weight distribution buckets (10 bins across actual data range)
   */
  computeWeightBuckets(weights) {
    if (weights.length === 0) return [];
    
    // Use reduce instead of spread to avoid stack overflow with large arrays
    let min = weights[0];
    let max = weights[0];
    for (let i = 1; i < weights.length; i++) {
      if (weights[i] < min) min = weights[i];
      if (weights[i] > max) max = weights[i];
    }
    
    const range = max - min;
    
    if (range === 0) {
      return [{ min, max, count: weights.length, label: min.toExponential(2) }];
    }
    
    const numBuckets = 10;
    const bucketSize = range / numBuckets;
    const buckets = Array.from({ length: numBuckets }, (_, i) => ({
      min: min + i * bucketSize,
      max: min + (i + 1) * bucketSize,
      count: 0
    }));
    
    weights.forEach(w => {
      const bucketIndex = Math.min(Math.floor((w - min) / bucketSize), numBuckets - 1);
      buckets[bucketIndex].count++;
    });
    
    // Generate labels based on magnitude
    buckets.forEach(b => {
      const absMax = Math.max(Math.abs(b.min), Math.abs(b.max));
      if (absMax >= 1) {
        b.label = `${b.min.toFixed(2)} to ${b.max.toFixed(2)}`;
      } else if (absMax >= 0.01) {
        b.label = `${b.min.toFixed(3)} to ${b.max.toFixed(3)}`;
      } else {
        b.label = `${b.min.toExponential(1)} to ${b.max.toExponential(1)}`;
      }
    });
    
    return buckets;
  }

  /**
   * Clean up resources
   */
  cleanup() {
    this.pgsBreakdown.clear();
    this.pgsDetails.clear();
    this.totalMatches = 0;
    this.totalScore = 0;
  }
}