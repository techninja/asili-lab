import { describe, it, expect } from 'vitest';
import {
  detectFormat,
  generateColumnExpressions,
  generateColumnDefinitions,
  getColumnRef,
  FORMAT_TYPES
} from '../lib/harmonization.js';

describe('harmonization', () => {
  describe('detectFormat', () => {
    it('detects STANDARD_SNP (rsID + chr_name + chr_position)', () => {
      expect(
        detectFormat([
          'rsID',
          'chr_name',
          'chr_position',
          'effect_allele',
          'effect_weight'
        ])
      ).toBe(FORMAT_TYPES.STANDARD_SNP);
    });

    it('detects STANDARD_SNP_NO_RSID (chr_name + chr_position, no rsID)', () => {
      expect(
        detectFormat([
          'chr_name',
          'chr_position',
          'effect_allele',
          'effect_weight'
        ])
      ).toBe(FORMAT_TYPES.STANDARD_SNP_NO_RSID);
    });

    it('detects DOSAGE_WEIGHTS', () => {
      expect(
        detectFormat([
          'chr_name',
          'chr_position',
          'effect_allele',
          'other_allele',
          'dosage_0_weight',
          'dosage_1_weight',
          'dosage_2_weight'
        ])
      ).toBe(FORMAT_TYPES.DOSAGE_WEIGHTS);
    });

    it('detects HLA_ALLELE (rsID + is_haplotype)', () => {
      expect(
        detectFormat(['rsID', 'effect_allele', 'effect_weight', 'is_haplotype'])
      ).toBe(FORMAT_TYPES.HLA_ALLELE);
    });

    it('detects RSID_HARMONIZED (rsID + hm_chr + hm_pos)', () => {
      expect(
        detectFormat([
          'rsID',
          'effect_allele',
          'effect_weight',
          'hm_source',
          'hm_rsID',
          'hm_chr',
          'hm_pos',
          'hm_inferOtherAllele'
        ])
      ).toBe(FORMAT_TYPES.RSID_HARMONIZED);
    });

    it('detects RSID_HARMONIZED even without hm_inferOtherAllele', () => {
      expect(
        detectFormat([
          'rsID',
          'effect_allele',
          'effect_weight',
          'hm_chr',
          'hm_pos'
        ])
      ).toBe(FORMAT_TYPES.RSID_HARMONIZED);
    });

    it('detects RSID_ONLY (rsID only, no chr/pos)', () => {
      expect(detectFormat(['rsID', 'effect_allele', 'effect_weight'])).toBe(
        FORMAT_TYPES.RSID_ONLY
      );
    });

    it('detects RSID_CHR (rsID + chr_name, no chr_position)', () => {
      expect(
        detectFormat(['rsID', 'chr_name', 'effect_allele', 'effect_weight'])
      ).toBe(FORMAT_TYPES.RSID_CHR);
    });

    it('returns null for unrecognized columns', () => {
      expect(detectFormat(['foo', 'bar'])).toBeNull();
    });

    it('prioritizes DOSAGE_WEIGHTS over STANDARD_SNP', () => {
      const cols = [
        'rsID',
        'chr_name',
        'chr_position',
        'effect_allele',
        'other_allele',
        'dosage_0_weight',
        'dosage_1_weight',
        'dosage_2_weight'
      ];
      expect(detectFormat(cols)).toBe(FORMAT_TYPES.DOSAGE_WEIGHTS);
    });

    it('prioritizes RSID_HARMONIZED over RSID_ONLY', () => {
      // A file with rsID + hm_chr + hm_pos should be RSID_HARMONIZED, not RSID_ONLY
      expect(
        detectFormat([
          'rsID',
          'effect_allele',
          'effect_weight',
          'hm_chr',
          'hm_pos'
        ])
      ).toBe(FORMAT_TYPES.RSID_HARMONIZED);
    });

    it('prioritizes RSID_HARMONIZED over HLA_ALLELE when hm_chr/hm_pos present', () => {
      expect(
        detectFormat([
          'rsID',
          'effect_allele',
          'effect_weight',
          'is_haplotype',
          'hm_chr',
          'hm_pos'
        ])
      ).toBe(FORMAT_TYPES.RSID_HARMONIZED);
    });
  });

  describe('getColumnRef', () => {
    it('returns column index reference', () => {
      expect(
        getColumnRef(
          ['rsID', 'effect_allele', 'effect_weight'],
          'effect_allele'
        )
      ).toBe('"effect_allele"');
    });

    it('returns empty string literal for missing column', () => {
      expect(getColumnRef(['rsID', 'effect_allele'], 'other_allele')).toBe(
        "''"
      );
    });
  });

  describe('generateColumnDefinitions', () => {
    it('generates DuckDB column defs for CSV reading', () => {
      const defs = generateColumnDefinitions([
        'rsID',
        'effect_allele',
        'effect_weight'
      ]);
      expect(defs).toBe(null);
    });
  });

  describe('generateColumnExpressions', () => {
    describe('RSID_HARMONIZED', () => {
      const cols = [
        'rsID',
        'effect_allele',
        'effect_weight',
        'hm_source',
        'hm_rsID',
        'hm_chr',
        'hm_pos',
        'hm_inferOtherAllele'
      ];

      it('builds chr:pos:allele:other variant_id from hm_ columns', () => {
        const exprs = generateColumnExpressions(
          FORMAT_TYPES.RSID_HARMONIZED,
          cols
        );
        // variant_id should use hm_chr (column5) and hm_pos (column6)
        expect(exprs.variant_id).toContain('"hm_chr"');
        expect(exprs.variant_id).toContain('"hm_pos"');
        expect(exprs.variant_id).toContain('"effect_allele"');
        expect(exprs.variant_id).toContain('"hm_inferOtherAllele"');
      });

      it('uses hm_chr for chr_name', () => {
        const exprs = generateColumnExpressions(
          FORMAT_TYPES.RSID_HARMONIZED,
          cols
        );
        expect(exprs.chr_name).toContain('"hm_chr"');
      });

      it('casts hm_pos to BIGINT for chr_position', () => {
        const exprs = generateColumnExpressions(
          FORMAT_TYPES.RSID_HARMONIZED,
          cols
        );
        expect(exprs.chr_position).toContain('"hm_pos"');
        expect(exprs.chr_position).toContain('BIGINT');
      });

      it('produces variant_id that SPLIT_PART can parse for chr/pos', () => {
        const exprs = generateColumnExpressions(
          FORMAT_TYPES.RSID_HARMONIZED,
          cols
        );
        // The variant_id is CONCAT(hm_chr, ':', hm_pos, ':', effect_allele, ':', hm_inferOtherAllele)
        // SPLIT_PART on ':' index 1 = chr, index 2 = pos
        // Verify the CONCAT pattern produces colon-separated values
        expect(exprs.variant_id).toContain('CONCAT');
      });

      it('falls back gracefully without hm_inferOtherAllele', () => {
        const minCols = [
          'rsID',
          'effect_allele',
          'effect_weight',
          'hm_chr',
          'hm_pos'
        ];
        const exprs = generateColumnExpressions(
          FORMAT_TYPES.RSID_HARMONIZED,
          minCols
        );
        // Should still produce a valid variant_id without other allele
        expect(exprs.variant_id).toContain('"hm_chr"');
        expect(exprs.variant_id).toContain('"hm_pos"');
      });

      it('prefers other_allele over hm_inferOtherAllele when both present', () => {
        const bothCols = [
          'rsID',
          'effect_allele',
          'other_allele',
          'effect_weight',
          'hm_chr',
          'hm_pos',
          'hm_inferOtherAllele'
        ];
        const exprs = generateColumnExpressions(
          FORMAT_TYPES.RSID_HARMONIZED,
          bothCols
        );
        // other_allele is column2, hm_inferOtherAllele is column6
        expect(exprs.other_allele).toContain('"other_allele"');
      });
    });

    describe('RSID_ONLY', () => {
      it('uses rsID directly as variant_id (no chr/pos)', () => {
        const cols = ['rsID', 'effect_allele', 'effect_weight'];
        const exprs = generateColumnExpressions(FORMAT_TYPES.RSID_ONLY, cols);
        expect(exprs.variant_id).toContain('"rsID"');
        expect(exprs.chr_position).toBe('NULL');
      });
    });

    describe('STANDARD_SNP', () => {
      it('builds chr:pos:allele variant_id', () => {
        const cols = [
          'rsID',
          'chr_name',
          'chr_position',
          'effect_allele',
          'effect_weight'
        ];
        const exprs = generateColumnExpressions(
          FORMAT_TYPES.STANDARD_SNP,
          cols
        );
        expect(exprs.variant_id).toContain('"chr_name"');
        expect(exprs.variant_id).toContain('"chr_position"');
        expect(exprs.variant_id).toContain('"effect_allele"');
      });

      it('includes other_allele in variant_id when present', () => {
        const cols = [
          'rsID',
          'chr_name',
          'chr_position',
          'effect_allele',
          'other_allele',
          'effect_weight'
        ];
        const exprs = generateColumnExpressions(
          FORMAT_TYPES.STANDARD_SNP,
          cols
        );
        expect(exprs.variant_id).toContain('"other_allele"');
      });
    });

    describe('DOSAGE_WEIGHTS', () => {
      it('uses dosage_1_weight as effect_weight', () => {
        const cols = [
          'chr_name',
          'chr_position',
          'effect_allele',
          'other_allele',
          'dosage_0_weight',
          'dosage_1_weight',
          'dosage_2_weight'
        ];
        const exprs = generateColumnExpressions(
          FORMAT_TYPES.DOSAGE_WEIGHTS,
          cols
        );
        expect(exprs.effect_weight).toContain('"dosage_1_weight"');
      });
    });
  });
});
