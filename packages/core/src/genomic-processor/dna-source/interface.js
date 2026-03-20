/**
 * DNA Source Interface
 * All DNA sources implement this contract — the scorer doesn't care
 * HOW matches were found, it just accumulates them.
 *
 * @typedef {Object} VariantMatch
 * @property {string} pgsId
 * @property {string} variantId    - chr:pos:ref:alt
 * @property {string} effectAllele
 * @property {number} effectWeight
 * @property {number} dosage       - 0-2 (continuous for imputed, integer for genotyped)
 * @property {boolean} imputed
 * @property {string} chromosome
 */

export class DNASource {
  /** @returns {Promise<string>} Human-readable description for logging */
  async describe() { return 'DNASource (base)'; }

  /**
   * Query DNA for matching variants against a trait's PGS variants.
   * @param {string} traitUrl - Path/URL to trait Parquet file
   * @param {Object} [options]
   * @returns {AsyncGenerator<VariantMatch>}
   */
  async *matchVariants(traitUrl, options = {}) {
    throw new Error('matchVariants must be implemented');
  }

  /** @returns {Promise<number>} Total variant count in this DNA source */
  async getVariantCount() { return 0; }

  async cleanup() {}
}
