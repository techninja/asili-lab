/**
 * Hybrid DNA Source — Genotyped in-memory + Imputed Parquet on-demand
 * For users with separate genotyped JSON + imputed Parquet (pre-unified migration).
 */

import { DNASource } from './interface.js';
import { GenotypedDNASource } from './genotyped-only.js';
import { UnifiedDNASource } from './unified.js';

export class HybridDNASource extends DNASource {
  constructor(genotypedVariants, imputedParquetPath, duckdb) {
    super();
    this.genotyped = new GenotypedDNASource(genotypedVariants);
    this.imputedPath = imputedParquetPath;
    this.db = duckdb;
    this.hasImputed = false;
  }

  async initialize() {
    this.hasImputed = this.imputedPath && await this.db.fileExists(this.imputedPath);
  }

  async describe() {
    return `HybridDNASource(${this.genotyped.posMap.size} genotyped, imputed=${this.hasImputed})`;
  }

  async *matchVariants(traitUrl, options = {}) {
    if (this.hasImputed) {
      const imputedSource = new UnifiedDNASource(this.imputedPath, this.db);
      const seenPositions = new Set();

      // Imputed batches first (higher coverage)
      for await (const batch of imputedSource.matchVariants(traitUrl, options)) {
        for (let i = 0; i < batch.length; i++) {
          const m = batch[i];
          const parts = m.variant_id.split(':');
          seenPositions.add(`${parts[0]}:${parts[1]}`);
        }
        yield batch;
      }

      // Genotyped-only matches for positions not covered by imputed
      const duckdb = options.duckdb || this.db;
      for await (const batch of this.genotyped.matchVariants(traitUrl, { ...options, duckdb })) {
        const filtered = [];
        for (let i = 0; i < batch.length; i++) {
          const m = batch[i];
          const parts = m.variant_id.split(':');
          if (!seenPositions.has(`${parts[0]}:${parts[1]}`)) {
            filtered.push(m);
          }
        }
        if (filtered.length > 0) yield filtered;
      }
    } else {
      yield* this.genotyped.matchVariants(traitUrl, options);
    }
  }

  async getVariantCount() {
    let count = this.genotyped.posMap.size;
    if (this.hasImputed) {
      count += await this.db.count(this.imputedPath);
    }
    return count;
  }

  async cleanup() {
    await this.genotyped.cleanup();
  }
}
