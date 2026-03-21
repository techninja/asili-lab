/**
 * Detect if PGS scores are LD-aware or need clumping
 */

// Methods that inherently account for LD
const LD_AWARE_METHODS = [
  'LDpred',
  'LDpred2',
  'LDpred-funct',
  'LDpred-inf',
  'LDpred-auto',
  'PRS-CS',
  'PRS-CSx',
  'lassosum',
  'SBLUP',
  'SBayesR',
  'MegaPRS',
  'JAMPred',
  'DBSLMM'
];

// Methods that produce independent variants
const CLUMPED_METHODS = [
  'Clumping + Thresholding',
  'C+T',
  'Pruning + Thresholding',
  'P+T'
];

/**
 * Determine if a PGS is LD-aware based on method name
 */
export function isLDAware(methodName) {
  if (!methodName) return false;

  const method = methodName.toLowerCase();

  // Check for LD-aware methods
  for (const ldMethod of LD_AWARE_METHODS) {
    if (method.includes(ldMethod.toLowerCase())) {
      return true;
    }
  }

  // Check for clumped methods
  for (const clumpedMethod of CLUMPED_METHODS) {
    if (method.includes(clumpedMethod.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Determine if a PGS needs clumping
 */
export function needsClumping(methodName, variantCount) {
  // Already LD-aware
  if (isLDAware(methodName)) return false;

  // Small PGS (<100 variants) unlikely to have LD issues
  // Only skip clumping if we KNOW it's small
  if (variantCount && variantCount > 0 && variantCount < 100) return false;

  // Unknown method or missing variant count - default to clumping for safety
  return true;
}

/**
 * Get LD status for a PGS
 */
export function getLDStatus(scoreData) {
  const method = scoreData.method_name || '';
  const variantCount = scoreData.variants_number || 0;

  const ld_aware = isLDAware(method);
  const needs_clumping = needsClumping(method, variantCount);

  return {
    ld_aware,
    needs_clumping,
    reason: ld_aware
      ? `Method "${method}" accounts for LD`
      : needs_clumping
        ? `Method "${method}" may have LD inflation`
        : 'Small variant count (<100)'
  };
}
