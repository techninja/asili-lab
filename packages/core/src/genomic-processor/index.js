/**
 * Genomic Processor Factory
 * Creates the appropriate DNA source + scorer based on platform and available data.
 */

export { PGSScorer } from './scorer.js';
export { SharedRiskCalculator } from './calculator.js';
export { DNASource } from './dna-source/interface.js';
export { UnifiedDNASource } from './dna-source/unified.js';
export { GenotypedDNASource } from './dna-source/genotyped-only.js';
export { HybridDNASource } from './dna-source/hybrid.js';
export * from './matcher.js';

/**
 * Create the best DNA source for a given individual.
 *
 * @param {Object} options
 * @param {string} options.individualId
 * @param {Object} options.duckdb - DuckDB adapter instance
 * @param {string} [options.unifiedPath] - Path to unified parquet
 * @param {string} [options.imputedPath] - Path to imputed parquet
 * @param {Array} [options.genotypedVariants] - Array of genotyped variants
 * @returns {Promise<import('./dna-source/interface.js').DNASource>}
 */
export async function createDNASource({ individualId, duckdb, unifiedPath, imputedPath, genotypedVariants }) {
  // 1. Unified Parquet (fastest — single DuckDB JOIN)
  if (unifiedPath && await duckdb.fileExists(unifiedPath)) {
    const { UnifiedDNASource } = await import('./dna-source/unified.js');
    return new UnifiedDNASource(unifiedPath, duckdb);
  }

  // 2. Hybrid (genotyped Map + imputed Parquet)
  if (imputedPath && genotypedVariants?.length) {
    const { HybridDNASource } = await import('./dna-source/hybrid.js');
    const source = new HybridDNASource(genotypedVariants, imputedPath, duckdb);
    await source.initialize();
    return source;
  }

  // 3. Genotyped only (Map lookup)
  if (genotypedVariants?.length) {
    const { GenotypedDNASource } = await import('./dna-source/genotyped-only.js');
    return new GenotypedDNASource(genotypedVariants);
  }

  throw new Error(`No DNA data available for individual ${individualId}`);
}
