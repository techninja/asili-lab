/**
 * Genotyped-Only DNA Source — In-memory Map lookup
 * For users without imputation. Works on both browser and server.
 */

import { DNASource } from './interface.js';
import { positionKey, countEffectAlleles } from '../matcher.js';

export class GenotypedDNASource extends DNASource {
  /**
   * @param {Array<{rsid, chromosome, position, allele1, allele2}>} variants
   */
  constructor(variants) {
    super();
    this.posMap = new Map();
    for (const v of variants) {
      if (v.chromosome && v.position) {
        this.posMap.set(`${v.chromosome}:${v.position}`, v);
      }
    }
  }

  async describe() {
    return `GenotypedDNASource(${this.posMap.size} variants)`;
  }

  /**
   * @param {string} traitUrl
   * @param {Object} options - must include `duckdb` adapter
   */
  async *matchVariants(traitUrl, { duckdb, chunkSize = 500_000 } = {}) {
    if (!duckdb)
      throw new Error('GenotypedDNASource requires duckdb adapter in options');

    const total = await duckdb.count(traitUrl);

    for (let offset = 0; offset < total; offset += chunkSize) {
      const rows = await duckdb.query(`
        SELECT variant_id, effect_allele, effect_weight, pgs_id
        FROM '${traitUrl}' LIMIT ${chunkSize} OFFSET ${offset}
      `);

      const batch = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const pk = positionKey(row.variant_id);
        const variant = pk ? this.posMap.get(pk) : null;
        if (!variant) continue;

        const dosage = countEffectAlleles(
          variant.allele1,
          variant.allele2,
          row.effect_allele
        );
        if (dosage === 0) continue;

        batch.push({
          pgs_id: row.pgs_id,
          variant_id: row.variant_id,
          effect_allele: row.effect_allele,
          effect_weight: row.effect_weight,
          dosage,
          imputed: false
        });
      }

      if (batch.length > 0) yield batch;
    }
  }

  async getVariantCount() {
    return this.posMap.size;
  }

  async cleanup() {
    this.posMap.clear();
  }
}
