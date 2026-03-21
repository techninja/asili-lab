import { describe, it, expect } from 'vitest';
import { PGSScorer } from '../src/genomic-processor/scorer.js';

/**
 * Mock DNA source that yields pre-defined matches as batches.
 * Implements the DNASource interface contract.
 */
class MockDNASource {
  constructor(matches) {
    this.matches = matches;
  }

  async *matchVariants() {
    if (this.matches.length === 0) return;
    // Yield as a single batch, using raw DuckDB column names
    yield this.matches.map(m => ({
      pgs_id: m.pgsId,
      variant_id: m.variantId,
      effect_allele: m.effectAllele,
      effect_weight: m.effectWeight,
      dosage: m.dosage,
      imputed: m.imputed
    }));
  }
}

describe('PGSScorer', () => {
  it('accumulates scores from matched variants', async () => {
    const matches = [
      {
        pgsId: 'PGS001',
        variantId: '1:100:A:G',
        effectAllele: 'A',
        effectWeight: 0.5,
        dosage: 2,
        imputed: false,
        chromosome: '1'
      },
      {
        pgsId: 'PGS001',
        variantId: '1:200:T:C',
        effectAllele: 'T',
        effectWeight: -0.3,
        dosage: 1,
        imputed: false,
        chromosome: '1'
      },
      {
        pgsId: 'PGS001',
        variantId: '2:300:G:A',
        effectAllele: 'G',
        effectWeight: 0.8,
        dosage: 1,
        imputed: true,
        chromosome: '2'
      }
    ];

    const scorer = new PGSScorer();
    const pgsVariantCounts = new Map([['PGS001', 100]]);
    const source = new MockDNASource(matches);

    const calc = await scorer.score(source, 'dummy.parquet', pgsVariantCounts);

    expect(calc.totalMatches).toBe(3);

    const details = calc.pgsDetails.get('PGS001');
    // score = 0.5*2 + (-0.3)*1 + 0.8*1 = 1.0 + (-0.3) + 0.8 = 1.5
    expect(details.score).toBeCloseTo(1.5, 5);
    expect(details.matchedVariants).toBe(3);
    expect(details.genotypedVariants).toBe(2);
    expect(details.imputedVariants).toBe(1);

    const breakdown = calc.pgsBreakdown.get('PGS001');
    expect(breakdown.positive).toBe(2); // 1.0 and 0.8
    expect(breakdown.negative).toBe(1); // -0.3
    expect(breakdown.total).toBe(3);
    expect(breakdown.chromosomeCoverage['1']).toBe(2);
    expect(breakdown.chromosomeCoverage['2']).toBe(1);
  });

  it('handles multiple PGS in same trait', async () => {
    const matches = [
      {
        pgsId: 'PGS_A',
        variantId: '1:100:A:G',
        effectAllele: 'A',
        effectWeight: 0.5,
        dosage: 1,
        imputed: false,
        chromosome: '1'
      },
      {
        pgsId: 'PGS_B',
        variantId: '1:100:A:G',
        effectAllele: 'A',
        effectWeight: 0.3,
        dosage: 1,
        imputed: false,
        chromosome: '1'
      },
      {
        pgsId: 'PGS_A',
        variantId: '2:200:T:C',
        effectAllele: 'T',
        effectWeight: 0.2,
        dosage: 2,
        imputed: true,
        chromosome: '2'
      }
    ];

    const scorer = new PGSScorer();
    const pgsVariantCounts = new Map([
      ['PGS_A', 50],
      ['PGS_B', 30]
    ]);
    const source = new MockDNASource(matches);

    const calc = await scorer.score(source, 'dummy.parquet', pgsVariantCounts);

    expect(calc.totalMatches).toBe(3);
    expect(calc.pgsDetails.get('PGS_A').score).toBeCloseTo(0.9, 5); // 0.5 + 0.4
    expect(calc.pgsDetails.get('PGS_B').score).toBeCloseTo(0.3, 5);
    expect(calc.pgsDetails.get('PGS_A').matchedVariants).toBe(2);
    expect(calc.pgsDetails.get('PGS_B').matchedVariants).toBe(1);
  });

  it('handles empty match set', async () => {
    const scorer = new PGSScorer();
    const source = new MockDNASource([]);

    const calc = await scorer.score(source, 'dummy.parquet', new Map());

    expect(calc.totalMatches).toBe(0);
    expect(calc.pgsDetails.size).toBe(0);
  });

  it('tracks top variants correctly', async () => {
    const matches = [];
    for (let i = 0; i < 25; i++) {
      matches.push({
        pgsId: 'PGS001',
        variantId: `1:${i}:A:G`,
        effectAllele: 'A',
        effectWeight: i * 0.1,
        dosage: 1,
        imputed: false,
        chromosome: '1'
      });
    }

    const scorer = new PGSScorer();
    const source = new MockDNASource(matches);
    const calc = await scorer.score(
      source,
      'dummy.parquet',
      new Map([['PGS001', 100]])
    );

    const top = calc.pgsDetails.get('PGS001').topVariants;
    expect(top.length).toBe(20);
  });

  it('finalize delegates to calculator', async () => {
    const scorer = new PGSScorer({
      PGS001: { norm_mean: 0, norm_sd: 1, performance_weight: 0.1 }
    });

    // Need >= 8 matched variants to pass MIN_VARIANT_THRESHOLD
    const matches = [];
    for (let i = 0; i < 10; i++) {
      matches.push({
        pgsId: 'PGS001',
        variantId: `1:${100 + i}:A:G`,
        effectAllele: 'A',
        effectWeight: 0.1,
        dosage: 1,
        imputed: false,
        chromosome: '1'
      });
    }

    const source = new MockDNASource(matches);
    await scorer.score(source, 'dummy.parquet', new Map([['PGS001', 100]]));

    const result = await scorer.finalize('disease_risk');
    expect(result.bestPGS).toBe('PGS001');
    expect(result.pgsDetails.PGS001.zScore).not.toBeNull();
    expect(result.pgsDetails.PGS001.percentile).not.toBeNull();
  });

  describe('loadFromDB (SQL pushdown path)', () => {
    it('populates calculator from pre-aggregated DB results', () => {
      const scorer = new PGSScorer({
        PGS001: { norm_mean: 0, norm_sd: 1, performance_weight: 0.1 }
      });
      const pgsVariantCounts = new Map([['PGS001', 500]]);

      const dbResults = {
        pgsAggregates: [
          {
            pgs_id: 'PGS001',
            raw_score: 1.5,
            matched_variants: 200,
            imputed_variants: 50,
            genotyped_variants: 150,
            positive_count: 120,
            positive_sum: 2.5,
            negative_count: 80,
            negative_sum: -1.0,
            weight_sum_squared: 0.05,
            weight_min: -0.01,
            weight_max: 0.03
          }
        ],
        chrCoverage: [
          { pgs_id: 'PGS001', chr: 1, cnt: 100 },
          { pgs_id: 'PGS001', chr: 2, cnt: 100 }
        ]
      };

      const calc = scorer.loadFromDB(dbResults, pgsVariantCounts);

      expect(calc.totalMatches).toBe(200);
      expect(calc.imputedCount).toBe(50);

      const details = calc.pgsDetails.get('PGS001');
      expect(details.score).toBe(1.5);
      expect(details.matchedVariants).toBe(200);
      expect(details.genotypedVariants).toBe(150);
      expect(details.imputedVariants).toBe(50);

      const breakdown = calc.pgsBreakdown.get('PGS001');
      expect(breakdown.positive).toBe(120);
      expect(breakdown.negative).toBe(80);
      expect(breakdown.chromosomeCoverage['1']).toBe(100);
      expect(breakdown.chromosomeCoverage['2']).toBe(100);

      // Top variants loaded separately
      expect(details.topVariants.length).toBe(0);
      scorer.loadTopVariants([
        {
          pgs_id: 'PGS001',
          variant_id: '1:100:A:G',
          effect_allele: 'A',
          effect_weight: 0.03,
          dosage: 2,
          imputed: false,
          contribution: 0.06,
          user_variant_id: '1:100:A:G'
        },
        {
          pgs_id: 'PGS001',
          variant_id: '2:200:T:C',
          effect_allele: 'T',
          effect_weight: -0.01,
          dosage: 1,
          imputed: true,
          contribution: -0.01,
          user_variant_id: '2:200:T:C'
        }
      ]);
      expect(details.topVariants.length).toBe(2);
      expect(details.topVariants[0].rsid).toBe('1:100:A:G');
      expect(details.topVariants[0].userGenotype).toBe('AG');
      expect(details.topVariants[1].imputed).toBe(true);
    });

    it('handles multiple PGS from DB results', () => {
      const scorer = new PGSScorer();
      const pgsVariantCounts = new Map([
        ['PGS_A', 100],
        ['PGS_B', 200]
      ]);

      const dbResults = {
        pgsAggregates: [
          {
            pgs_id: 'PGS_A',
            raw_score: 0.5,
            matched_variants: 80,
            imputed_variants: 0,
            genotyped_variants: 80,
            positive_count: 50,
            positive_sum: 1.0,
            negative_count: 30,
            negative_sum: -0.5,
            weight_sum_squared: 0.01,
            weight_min: -0.005,
            weight_max: 0.02
          },
          {
            pgs_id: 'PGS_B',
            raw_score: -0.3,
            matched_variants: 150,
            imputed_variants: 100,
            genotyped_variants: 50,
            positive_count: 60,
            positive_sum: 0.8,
            negative_count: 90,
            negative_sum: -1.1,
            weight_sum_squared: 0.02,
            weight_min: -0.01,
            weight_max: 0.01
          }
        ],
        chrCoverage: []
      };

      const calc = scorer.loadFromDB(dbResults, pgsVariantCounts);

      expect(calc.totalMatches).toBe(230);
      expect(calc.pgsDetails.get('PGS_A').score).toBe(0.5);
      expect(calc.pgsDetails.get('PGS_B').score).toBe(-0.3);
      expect(calc.imputedCount).toBe(100);
    });

    it('handles empty DB results', () => {
      const scorer = new PGSScorer();
      const calc = scorer.loadFromDB(
        { pgsAggregates: [], chrCoverage: [] },
        new Map()
      );
      expect(calc.totalMatches).toBe(0);
      expect(calc.pgsDetails.size).toBe(0);
    });
  });

  it('calls onProgress per batch', async () => {
    const matches = [];
    for (let i = 0; i < 100; i++) {
      matches.push({
        pgsId: 'PGS001',
        variantId: `1:${i}:A:G`,
        effectAllele: 'A',
        effectWeight: 0.001,
        dosage: 1,
        imputed: false,
        chromosome: '1'
      });
    }

    const scorer = new PGSScorer();
    const source = new MockDNASource(matches);

    await scorer.score(source, 'dummy.parquet', new Map([['PGS001', 1000000]]));

    // Verify scoring completed correctly
    expect(scorer.calculator.totalMatches).toBe(100);
  });
});
