import { describe, it, expect } from 'vitest';
import { SharedRiskCalculator } from '../src/genomic-processor/calculator.js';

describe('calculator', () => {
  describe('static methods', () => {
    it('calculates z-score correctly', () => {
      expect(
        SharedRiskCalculator.calculateZScore(1.5, { mean: 1.0, sd: 0.5 })
      ).toBe(1.0);
      expect(SharedRiskCalculator.calculateZScore(0, { mean: 0, sd: 1 })).toBe(
        0
      );
    });

    it('returns null z-score for missing stats', () => {
      expect(SharedRiskCalculator.calculateZScore(1.0, null)).toBeNull();
      expect(
        SharedRiskCalculator.calculateZScore(1.0, { mean: 0, sd: 0 })
      ).toBeNull();
    });

    it('calculates percentile from z-score', () => {
      const p50 = SharedRiskCalculator.calculatePercentile(0);
      expect(p50).toBeCloseTo(50, 0);

      const p84 = SharedRiskCalculator.calculatePercentile(1);
      expect(p84).toBeCloseTo(84.1, 0);

      const p16 = SharedRiskCalculator.calculatePercentile(-1);
      expect(p16).toBeCloseTo(15.9, 0);
    });

    it('returns null percentile for null z-score', () => {
      expect(SharedRiskCalculator.calculatePercentile(null)).toBeNull();
    });

    it('calculates theoretical SD', () => {
      // sqrt(sum(w²) * 0.5) with sum(w²) = 4, count = 2
      const sd = SharedRiskCalculator.estimateTheoreticalSD(4, 2);
      expect(sd).toBeCloseTo(Math.sqrt(2), 5);
    });

    it('returns 1.0 for empty theoretical SD', () => {
      expect(SharedRiskCalculator.estimateTheoreticalSD(0, 0)).toBe(1.0);
    });

    it('calculates confidence levels', () => {
      expect(SharedRiskCalculator.calculateConfidence(0)).toBe('none');
      expect(SharedRiskCalculator.calculateConfidence(5)).toBe('insufficient');
      expect(SharedRiskCalculator.calculateConfidence(9)).toBe('low');
      expect(SharedRiskCalculator.calculateConfidence(50)).toBe('medium');
      expect(SharedRiskCalculator.calculateConfidence(200)).toBe('high');
    });
  });

  describe('quality score', () => {
    it('returns 0 for no matched variants', () => {
      expect(SharedRiskCalculator.calculatePGSQualityScore(0, 100, 0.1)).toBe(
        0
      );
    });

    it('returns 0 for no total variants', () => {
      expect(SharedRiskCalculator.calculatePGSQualityScore(50, 0, 0.1)).toBe(0);
    });

    it('higher R² produces higher score', () => {
      const low = SharedRiskCalculator.calculatePGSQualityScore(
        100,
        100,
        0.01,
        true,
        1.0,
        100
      );
      const high = SharedRiskCalculator.calculatePGSQualityScore(
        100,
        100,
        0.5,
        true,
        1.0,
        100
      );
      expect(high).toBeGreaterThan(low);
    });

    it('higher genotyped ratio produces higher score', () => {
      const allImputed = SharedRiskCalculator.calculatePGSQualityScore(
        100,
        100,
        0.1,
        true,
        1.0,
        0
      );
      const allGenotyped = SharedRiskCalculator.calculatePGSQualityScore(
        100,
        100,
        0.1,
        true,
        1.0,
        100
      );
      expect(allGenotyped).toBeGreaterThan(allImputed);
    });

    it('applies coverage penalty below 5%', () => {
      const low = SharedRiskCalculator.calculatePGSQualityScore(
        2,
        100,
        0.5,
        true,
        1.0,
        2
      );
      const high = SharedRiskCalculator.calculatePGSQualityScore(
        50,
        100,
        0.5,
        true,
        1.0,
        50
      );
      expect(high).toBeGreaterThan(low);
    });

    it('zeroes signal strength for extreme z-scores (>5σ)', () => {
      const normal = SharedRiskCalculator.calculatePGSQualityScore(
        100,
        100,
        0.1,
        true,
        2.0,
        100
      );
      const extreme = SharedRiskCalculator.calculatePGSQualityScore(
        100,
        100,
        0.1,
        true,
        21.0,
        100
      );
      // Extreme z should get 0 signal points, so lower total
      expect(extreme).toBeLessThan(normal);
    });

    it('quality score breakdown sums to total', () => {
      const breakdown = SharedRiskCalculator.getQualityScoreBreakdown(
        100,
        200,
        0.1,
        true,
        1.5,
        80
      );
      const componentSum = breakdown.components.reduce(
        (sum, c) => sum + c.score,
        0
      );
      expect(componentSum).toBeCloseTo(breakdown.total, 0);
    });
  });

  describe('normalization fix', () => {
    it('does NOT scale mean/SD by coverage (the critical fix)', async () => {
      const calc = new SharedRiskCalculator({
        PGS001: {
          norm_mean: 0.5,
          norm_sd: 0.2,
          performance_weight: 0.1,
          variants_number: 1000
        }
      });

      // Simulate a PGS with 15% coverage (150/1000 variants matched)
      calc.initializePGS('PGS001', {
        norm_mean: 0.5,
        norm_sd: 0.2,
        variants_number: 1000
      });
      const details = calc.pgsDetails.get('PGS001');
      const breakdown = calc.pgsBreakdown.get('PGS001');

      details.matchedVariants = 150;
      details.score = 0.08;
      details.genotypedVariants = 100;
      details.imputedVariants = 50;
      breakdown.total = 150;
      breakdown.weightSumSquared = 0.01;
      breakdown.genotypedVariants = 100;
      breakdown.imputedVariants = 50;
      calc.totalMatches = 150;

      const result = await calc.finalize('disease_risk');

      // The z-score should use UNSCALED mean=0.5, sd=0.2
      // z = (0.08 - 0.5) / 0.2 = -2.1
      const pgs = result.pgsDetails.PGS001;
      expect(pgs.normMean).toBe(0.5); // NOT 0.5 * 0.15 = 0.075
      expect(pgs.normSd).toBe(0.2); // NOT 0.2 * 0.15 = 0.03
      expect(pgs.normalizationScaled).toBe(false);
      expect(pgs.zScore).toBeCloseTo(-2.1, 1);
    });

    it('uses theoretical normalization when no empirical data', async () => {
      const calc = new SharedRiskCalculator({});

      calc.initializePGS('PGS_NO_NORM', {});
      const details = calc.pgsDetails.get('PGS_NO_NORM');
      const breakdown = calc.pgsBreakdown.get('PGS_NO_NORM');

      details.matchedVariants = 50;
      details.score = 0.5;
      breakdown.total = 50;
      breakdown.weightSumSquared = 0.1;
      calc.totalMatches = 50;

      const result = await calc.finalize('disease_risk');
      const pgs = result.pgsDetails.PGS_NO_NORM;

      // Should use theoretical: mean=0, sd=sqrt(0.1 * 0.5) = sqrt(0.05)
      expect(pgs.normMean).toBe(0);
      expect(pgs.normSd).toBeCloseTo(Math.sqrt(0.05), 5);
      expect(pgs.zScore).not.toBeNull();
    });

    it('uses theoretical normalization when coverage < 5%', async () => {
      const calc = new SharedRiskCalculator({
        PGS_LOW: {
          norm_mean: 1.0,
          norm_sd: 0.5,
          performance_weight: 0.1,
          variants_number: 10000
        }
      });

      // variants_number in metadata represents parquet count
      // breakdown.total tracks matched variants (what we actually scored)
      calc.initializePGS('PGS_LOW', {
        norm_mean: 1.0,
        norm_sd: 0.5,
        variants_number: 10000
      });
      const details = calc.pgsDetails.get('PGS_LOW');
      const breakdown = calc.pgsBreakdown.get('PGS_LOW');

      // 3% coverage: 300 matched out of 10000 in parquet
      // metadata.variants_number = parquet count (denominator)
      // breakdown.total = matched count
      details.matchedVariants = 300;
      details.score = 0.01;
      breakdown.total = 300; // matched count
      breakdown.weightSumSquared = 0.001;
      calc.totalMatches = 300;

      const result = await calc.finalize('disease_risk');
      const pgs = result.pgsDetails.PGS_LOW;

      // Should fall back to theoretical (mean=0) because 300/10000 = 3% < 5%
      expect(pgs.normMean).toBe(0);
      expect(pgs.insufficientCoverage).toBe(true);
    });

    it('detects incompatible empirical stats and falls back to theoretical', async () => {
      // Simulates PGS000017: gnomAD mean=193.5 over 6.9M variants,
      // but raw score=0.79 from 11% coverage — clearly different distribution
      const calc = new SharedRiskCalculator({
        PGS_BAD: {
          norm_mean: 193.5,
          norm_sd: 0.08,
          performance_weight: 0.1,
          variants_number: 6900000
        }
      });

      calc.initializePGS('PGS_BAD', {
        norm_mean: 193.5,
        norm_sd: 0.08,
        variants_number: 6900000
      });
      const details = calc.pgsDetails.get('PGS_BAD');
      const breakdown = calc.pgsBreakdown.get('PGS_BAD');

      details.matchedVariants = 790000; // ~11% coverage
      details.score = 0.79;
      details.genotypedVariants = 790000;
      breakdown.total = 790000;
      breakdown.weightSumSquared = 0.001;
      breakdown.genotypedVariants = 790000;
      calc.totalMatches = 790000;

      const result = await calc.finalize('disease_risk');
      const pgs = result.pgsDetails.PGS_BAD;

      // Should NOT use empirical (naiveZ = |0.79 - 193.5| / 0.08 = 2409σ)
      // Should fall back to theoretical (mean=0)
      expect(pgs.normMean).toBe(0);
      expect(Math.abs(pgs.zScore)).toBeLessThan(50); // not 2409σ
    });
  });

  describe('finalize', () => {
    it('selects best PGS by quality score', async () => {
      const calc = new SharedRiskCalculator({
        PGS_A: { norm_mean: 0, norm_sd: 1, performance_weight: 0.01 },
        PGS_B: { norm_mean: 0, norm_sd: 1, performance_weight: 0.5 }
      });

      for (const pgsId of ['PGS_A', 'PGS_B']) {
        calc.initializePGS(pgsId, calc.normalizationParams[pgsId]);
        const d = calc.pgsDetails.get(pgsId);
        const b = calc.pgsBreakdown.get(pgsId);
        d.matchedVariants = 100;
        d.score = 0.5;
        d.genotypedVariants = 100;
        b.total = 100;
        b.weightSumSquared = 1;
        b.genotypedVariants = 100;
        calc.totalMatches += 100;
      }

      const result = await calc.finalize('disease_risk');
      // PGS_B has higher R² so should be selected as best
      expect(result.bestPGS).toBe('PGS_B');
    });

    it('selects best PGS even when all are insufficient data', async () => {
      // Simulates the 7 traits where all PGS have < 8 matched variants
      const calc = new SharedRiskCalculator({
        PGS_TINY: {
          norm_mean: 0,
          norm_sd: 1,
          performance_weight: 0.05,
          variants_number: 14
        }
      });

      calc.initializePGS('PGS_TINY', {
        norm_mean: 0,
        norm_sd: 1,
        variants_number: 14
      });
      const d = calc.pgsDetails.get('PGS_TINY');
      const b = calc.pgsBreakdown.get('PGS_TINY');

      d.matchedVariants = 4; // below MIN_VARIANT_THRESHOLD (8)
      d.score = 0.1;
      d.genotypedVariants = 4;
      b.total = 4;
      b.weightSumSquared = 0.01;
      b.genotypedVariants = 4;
      calc.totalMatches = 4;

      const result = await calc.finalize('disease_risk');

      // Should still select a best PGS (with low confidence) rather than null
      expect(result.bestPGS).toBe('PGS_TINY');
      expect(result.zScore).not.toBeNull();
      expect(result.confidence).toBe('insufficient');
    });

    it('computes quantitative trait values', async () => {
      const calc = new SharedRiskCalculator({
        PGS_Q: { norm_mean: 0, norm_sd: 1, performance_weight: 0.25 }
      });

      calc.initializePGS('PGS_Q', calc.normalizationParams.PGS_Q);
      const d = calc.pgsDetails.get('PGS_Q');
      const b = calc.pgsBreakdown.get('PGS_Q');
      d.matchedVariants = 500;
      d.score = 1.0; // z = (1.0 - 0) / 1 = 1.0
      d.genotypedVariants = 500;
      b.total = 500;
      b.weightSumSquared = 1;
      b.genotypedVariants = 500;
      calc.totalMatches = 500;

      const result = await calc.finalize('quantitative', 'kg/m²', 25.0, 4.0, {
        PGS_Q: { r2: 0.25 }
      });

      // phenotype z = genetic z * sqrt(R²) = 1.0 * 0.5 = 0.5
      // value = 25.0 + 0.5 * 4.0 = 27.0
      expect(result.value).toBeCloseTo(27.0, 1);
    });
  });

  describe('addTopVariant', () => {
    it('keeps top 20 by contribution magnitude', () => {
      const calc = new SharedRiskCalculator();
      calc.initializePGS('PGS1', {});

      // Add 25 variants with increasing contribution
      for (let i = 0; i < 25; i++) {
        calc.addTopVariant('PGS1', {
          rsid: `rs${i}`,
          contribution: i * 0.1,
          effect_weight: 0.1,
          effect_allele: 'A',
          chromosome: '1',
          imputed: false,
          quality: 1.0
        });
      }

      const top = calc.pgsDetails.get('PGS1').topVariants;
      expect(top.length).toBe(20);

      // The smallest contribution in top 20 should be >= 0.5 (variants 5-24)
      const minContribution = Math.min(
        ...top.map(v => Math.abs(v.contribution))
      );
      expect(minContribution).toBeGreaterThanOrEqual(0.5);
    });
  });
});
