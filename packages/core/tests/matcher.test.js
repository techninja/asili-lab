import { describe, it, expect } from 'vitest';
import {
  positionKey,
  resolveAlleleDosage,
  countEffectAlleles,
  buildPositionMap
} from '../src/genomic-processor/matcher.js';

describe('matcher', () => {
  describe('positionKey', () => {
    it('extracts chr:pos from chr:pos:ref:alt', () => {
      expect(positionKey('1:12345:A:G')).toBe('1:12345');
    });

    it('returns full string for chr:pos only', () => {
      expect(positionKey('1:12345')).toBe('1:12345');
    });

    it('returns null for rsid without colon', () => {
      expect(positionKey('rs12345')).toBeNull();
    });

    it('handles chr prefix', () => {
      expect(positionKey('chr1:99999:T:C')).toBe('chr1:99999');
    });
  });

  describe('resolveAlleleDosage', () => {
    it('returns raw dosage when alleles match', () => {
      expect(resolveAlleleDosage('A', 'G', 'A', 'G', 1.5)).toBe(1.5);
    });

    it('flips dosage when alleles are swapped', () => {
      expect(resolveAlleleDosage('A', 'G', 'G', 'A', 1.5)).toBe(0.5);
    });

    it('returns null for incompatible alleles', () => {
      expect(resolveAlleleDosage('A', 'G', 'C', 'T', 1.0)).toBeNull();
    });

    it('handles dosage 0 flip correctly', () => {
      expect(resolveAlleleDosage('A', 'G', 'G', 'A', 0)).toBe(2);
    });

    it('handles dosage 2 flip correctly', () => {
      expect(resolveAlleleDosage('A', 'G', 'G', 'A', 2)).toBe(0);
    });
  });

  describe('countEffectAlleles', () => {
    it('returns 2 for homozygous effect', () => {
      expect(countEffectAlleles('A', 'A', 'A')).toBe(2);
    });

    it('returns 1 for heterozygous', () => {
      expect(countEffectAlleles('A', 'G', 'A')).toBe(1);
    });

    it('returns 0 for no match', () => {
      expect(countEffectAlleles('G', 'G', 'A')).toBe(0);
    });
  });

  describe('buildPositionMap', () => {
    it('builds map keyed by chr:pos', () => {
      const variants = [
        { chromosome: '1', position: 100, allele1: 'A', allele2: 'G' },
        { chromosome: '2', position: 200, allele1: 'T', allele2: 'C' }
      ];
      const map = buildPositionMap(variants);
      expect(map.size).toBe(2);
      expect(map.get('1:100')).toBe(variants[0]);
      expect(map.get('2:200')).toBe(variants[1]);
    });

    it('skips variants without chromosome or position', () => {
      const variants = [
        { chromosome: '1', position: 100, allele1: 'A', allele2: 'G' },
        { rsid: 'rs123' } // no chr/pos
      ];
      const map = buildPositionMap(variants);
      expect(map.size).toBe(1);
    });
  });
});
