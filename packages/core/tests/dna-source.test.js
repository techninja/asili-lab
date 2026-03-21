import { describe, it, expect } from 'vitest';
import { GenotypedDNASource } from '../src/genomic-processor/dna-source/genotyped-only.js';

/**
 * Mock DuckDB adapter that returns canned trait data.
 */
class MockDuckDB {
  constructor(traitRows) {
    this.traitRows = traitRows;
  }

  async count() {
    return this.traitRows.length;
  }

  async query(_sql) {
    // Simple: return all rows (ignores LIMIT/OFFSET for test simplicity)
    return this.traitRows;
  }
}

describe('GenotypedDNASource', () => {
  const userVariants = [
    { chromosome: '1', position: 100, allele1: 'A', allele2: 'G', rsid: 'rs1' },
    { chromosome: '1', position: 200, allele1: 'T', allele2: 'T', rsid: 'rs2' },
    { chromosome: '2', position: 300, allele1: 'C', allele2: 'G', rsid: 'rs3' },
  ];

  it('matches variants by position', async () => {
    const traitRows = [
      { variant_id: '1:100:A:G', effect_allele: 'A', effect_weight: '0.5', pgs_id: 'PGS001' },
      { variant_id: '1:200:T:C', effect_allele: 'T', effect_weight: '0.3', pgs_id: 'PGS001' },
      { variant_id: '3:999:X:Y', effect_allele: 'X', effect_weight: '0.1', pgs_id: 'PGS001' }, // no match
    ];

    const source = new GenotypedDNASource(userVariants);
    const duckdb = new MockDuckDB(traitRows);
    const matches = [];

    for await (const batch of source.matchVariants('dummy.parquet', { duckdb })) {
      matches.push(...batch);
    }

    expect(matches.length).toBe(2);
    expect(matches[0].dosage).toBe(1); // A/G → 1 copy of A
    expect(matches[1].dosage).toBe(2); // T/T → 2 copies of T
    expect(matches.every(m => m.imputed === false)).toBe(true);
  });

  it('skips variants with 0 effect allele count', async () => {
    const traitRows = [
      { variant_id: '2:300:C:G', effect_allele: 'A', effect_weight: '0.5', pgs_id: 'PGS001' }, // C/G, effect=A → 0
    ];

    const source = new GenotypedDNASource(userVariants);
    const duckdb = new MockDuckDB(traitRows);
    const matches = [];

    for await (const batch of source.matchVariants('dummy.parquet', { duckdb })) {
      matches.push(...batch);
    }

    expect(matches.length).toBe(0);
  });

  it('yields correct fields per match', async () => {
    const traitRows = [
      { variant_id: '1:100:A:G', effect_allele: 'A', effect_weight: '0.5', pgs_id: 'PGS001' },
    ];

    const source = new GenotypedDNASource(userVariants);
    const duckdb = new MockDuckDB(traitRows);
    const matches = [];

    for await (const batch of source.matchVariants('dummy.parquet', { duckdb })) {
      matches.push(...batch);
    }

    const m = matches[0];
    expect(m).toEqual({
      pgs_id: 'PGS001',
      variant_id: '1:100:A:G',
      effect_allele: 'A',
      effect_weight: '0.5',
      dosage: 1,
      imputed: false
    });
  });

  it('reports variant count', async () => {
    const source = new GenotypedDNASource(userVariants);
    expect(await source.getVariantCount()).toBe(3);
  });

  it('throws without duckdb adapter', async () => {
    const source = new GenotypedDNASource(userVariants);

    await expect(async () => {
      for await (const _ of source.matchVariants('dummy.parquet')) { /* noop */ }
    }).rejects.toThrow('requires duckdb adapter');
  });

  it('handles empty variant list', async () => {
    const source = new GenotypedDNASource([]);
    const duckdb = new MockDuckDB([
      { variant_id: '1:100:A:G', effect_allele: 'A', effect_weight: '0.5', pgs_id: 'PGS001' },
    ]);

    const matches = [];
    for await (const batch of source.matchVariants('dummy.parquet', { duckdb })) {
      matches.push(...batch);
    }

    expect(matches.length).toBe(0);
  });
});
