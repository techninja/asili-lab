/**
 * Variant matching utilities
 * Shared position-based matching, allele flipping, dosage calculation
 */

/**
 * Extract chr:pos key from a variant ID (handles chr:pos:ref:alt format)
 */
export function positionKey(variantId) {
  const i = variantId.indexOf(':');
  if (i === -1) return null;
  const j = variantId.indexOf(':', i + 1);
  return j === -1 ? variantId : variantId.substring(0, j);
}

/**
 * Check if alleles are flipped (REF/ALT swapped) and return adjusted dosage.
 * PGS may list A:T while imputed data has T:A at the same position.
 *
 * @returns {number|null} Adjusted dosage, or null if alleles are incompatible
 */
export function resolveAlleleDosage(pgsRef, pgsAlt, dnaRef, dnaAlt, rawDosage) {
  if (pgsRef === dnaRef && pgsAlt === dnaAlt) return rawDosage;
  if (pgsRef === dnaAlt && pgsAlt === dnaRef) return 2 - rawDosage;
  return null;
}

/**
 * Count effect alleles in a genotyped variant (0, 1, or 2)
 */
export function countEffectAlleles(allele1, allele2, effectAllele) {
  let count = 0;
  if (allele1 === effectAllele) count++;
  if (allele2 === effectAllele) count++;
  return count;
}

/**
 * Build a position-keyed Map from an array of genotyped variants.
 * Each variant is stored under its chr:pos key for O(1) lookup.
 */
export function buildPositionMap(variants) {
  const map = new Map();
  for (const v of variants) {
    if (v.chromosome && v.position) {
      map.set(`${v.chromosome}:${v.position}`, v);
    }
  }
  return map;
}
