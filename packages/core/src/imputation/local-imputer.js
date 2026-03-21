/**
 * Local LD-based imputation engine
 * Uses pre-computed reference panels to impute missing variants
 */

import { Debug } from '../utils/debug.js';

export class LocalImputer {
  constructor(duckdb, options = {}) {
    this.db = duckdb;
    this.population = options.population || 'EUR';
    this.minQuality = options.minQuality || 0.3;
    this.minMAF = options.minMAF || 0.01;
    this.dataPath = options.dataPath || '/data/imputation';
    this.cache = new Map();
  }

  async imputeVariants(userDNA, targetRSIDs, chromosome = null) {
    console.log('🔥🔥🔥 LocalImputer.imputeVariants CALLED');
    console.log('🔥 targetRSIDs count:', targetRSIDs.length);
    console.log('🔥 Sample targetRSIDs:', targetRSIDs.slice(0, 5));
    console.log('🔥 userDNA count:', userDNA.length);
    console.log('🔥 this.population:', this.population);
    console.log('🔥 this.dataPath:', this.dataPath);

    Debug.log(
      2,
      'LocalImputer',
      `Imputing ${targetRSIDs.length} variants for ${this.population}`
    );

    const userLookup = this.buildUserLookup(userDNA);
    console.log('🔥 userLookup size:', userLookup.size);

    // Create mapping from normalized ID back to original
    const idMap = new Map();
    targetRSIDs.forEach(rsid => {
      if (rsid.match(/^\d+:\d+:/)) {
        const parts = rsid.split(':');
        idMap.set(`chr${parts[0]}:${parts[1]}`, rsid);
      } else if (rsid.match(/^\d+:\d+$/)) {
        const parts = rsid.split(':');
        idMap.set(`chr${parts[0]}:${parts[1]}`, rsid);
      } else {
        idMap.set(rsid, rsid);
      }
    });

    console.log('🔥 Querying reference panel...');
    const refData = await this.queryReferencePanel(targetRSIDs, chromosome);
    console.log('🔥 Reference panel returned:', refData.length, 'variants');

    const imputed = [];
    let highQuality = 0;
    let nullResults = 0;
    let lowQuality = 0;

    for (let idx = 0; idx < refData.length; idx++) {
      const variant = refData[idx];

      const result = this.calculateDosage(variant, userLookup);

      if (!result) {
        nullResults++;
        continue;
      }

      if (result.quality < this.minQuality) {
        lowQuality++;
        continue;
      }

      const originalRsid = idMap.get(variant.rsid) || variant.rsid;
      imputed.push({
        rsid: originalRsid,
        chromosome: variant.chr,
        position: variant.pos,
        allele1: result.dosage >= 1 ? variant.alt : variant.ref,
        allele2: result.dosage >= 1 ? variant.alt : variant.ref,
        dosage: result.dosage,
        imputed: true,
        quality: result.quality,
        tagSNPsUsed: result.tagsUsed
      });

      if (result.quality >= 0.8) highQuality++;
    }

    console.log(
      '🔥 Imputation complete:',
      imputed.length,
      'imputed,',
      highQuality,
      'high quality'
    );
    console.log('🔥 Null results:', nullResults, ', Low quality:', lowQuality);

    Debug.log(
      2,
      'LocalImputer',
      `Imputed ${imputed.length} variants (high quality: ${highQuality})`
    );
    return imputed;
  }

  buildUserLookup(userDNA) {
    const lookup = new Map();
    console.log('🔥 Building user lookup from', userDNA.length, 'variants');
    console.log('🔥 Sample userDNA[0]:', userDNA[0]);

    for (const variant of userDNA) {
      // Index by rsid
      if (variant.rsid) {
        lookup.set(variant.rsid, variant);
      }
      // Index by chr:pos (CRITICAL for tag SNP matching)
      if (variant.chromosome && variant.position) {
        const chrPos = `chr${variant.chromosome}:${variant.position}`;
        lookup.set(chrPos, variant);
      }
    }

    console.log('🔥 User lookup built with', lookup.size, 'entries');
    console.log('🔥 Sample keys:', Array.from(lookup.keys()).slice(0, 5));
    return lookup;
  }

  async queryReferencePanel(targetRSIDs, chromosome = null) {
    const filePattern = chromosome
      ? `${this.dataPath}/1000g_${this.population.toLowerCase()}_chr${chromosome}.parquet`
      : `${this.dataPath}/1000g_${this.population.toLowerCase()}_chr*.parquet`;

    Debug.log(2, 'LocalImputer', `🔍 Query pattern: ${filePattern}`);
    Debug.log(
      2,
      'LocalImputer',
      `🔍 Sample target RSIDs: ${targetRSIDs.slice(0, 5).join(', ')}`
    );

    // Normalize rsIDs to match reference panel format (chr:pos)
    const normalizedRSIDs = targetRSIDs.map(rsid => {
      // If format is "22:12345:A:G", extract "chr22:12345"
      if (rsid.match(/^\d+:\d+:/)) {
        const parts = rsid.split(':');
        return `chr${parts[0]}:${parts[1]}`;
      }
      // If format is "22:12345", add chr prefix
      if (rsid.match(/^\d+:\d+$/)) {
        const parts = rsid.split(':');
        return `chr${parts[0]}:${parts[1]}`;
      }
      return rsid;
    });

    Debug.log(
      2,
      'LocalImputer',
      `🔍 Sample normalized: ${normalizedRSIDs.slice(0, 5).join(', ')}`
    );
    const rsidList = normalizedRSIDs.map(r => `'${r}'`).join(',');

    const query = `
      SELECT chr, pos, rsid, ref, alt, maf, tag_snps, tag_r2, haplotype_probs, imputation_quality
      FROM read_parquet('${filePattern}')
      WHERE rsid IN (${rsidList}) AND maf >= ${this.minMAF} AND imputation_quality >= ${this.minQuality}
    `;

    Debug.log(3, 'LocalImputer', `🔍 Query: ${query.substring(0, 200)}...`);

    return new Promise((resolve, reject) => {
      this.db.all(query, (err, rows) => {
        if (err) {
          Debug.log(1, 'LocalImputer', `❌ Query failed: ${err.message}`);
          reject(err);
        } else {
          Debug.log(
            2,
            'LocalImputer',
            `✅ Found ${rows.length} variants in reference panel`
          );

          // Convert BigInt values to regular numbers to avoid serialization issues
          const sanitized = rows.map(row => ({
            ...row,
            pos: Number(row.pos),
            chr: row.chr?.toString(),
            tag_snps: Array.isArray(row.tag_snps) ? row.tag_snps : [],
            tag_r2: Array.isArray(row.tag_r2) ? row.tag_r2 : []
          }));

          if (sanitized.length > 0) {
            Debug.log(
              3,
              'LocalImputer',
              `🔍 Sample result: chr=${sanitized[0].chr}, pos=${sanitized[0].pos}, tags=${sanitized[0].tag_snps?.length}`
            );
          }
          resolve(sanitized);
        }
      });
    });
  }

  calculateDosage(variant, userLookup) {
    if (!variant.tag_snps || variant.tag_snps.length === 0) {
      return null;
    }

    if (Math.random() < 0.01) {
      // Log 1% of variants
      console.log('🔥 Sample tag_snps:', variant.tag_snps.slice(0, 3));
    }

    const availableTags = [];
    for (let i = 0; i < variant.tag_snps.length; i++) {
      const tagSnp = variant.tag_snps[i];
      const userVariant = userLookup.get(tagSnp);
      if (userVariant) {
        availableTags.push({
          rsid: tagSnp,
          r2: variant.tag_r2[i],
          genotype: userVariant
        });
      }
    }

    if (availableTags.length === 0) return null;

    const haplotypeProbs = JSON.parse(variant.haplotype_probs);
    let dosage = 0;
    let totalWeight = 0;

    for (const tag of availableTags) {
      const weight = tag.r2;
      const tagDosage = this.countEffectAlleles(tag.genotype, variant.alt);
      const expectedDosage = haplotypeProbs.p_01 + 2 * haplotypeProbs.p_11;
      const adjustment = (tagDosage - 1) * 0.5;

      dosage += (expectedDosage + adjustment) * weight;
      totalWeight += weight;
    }

    return totalWeight > 0
      ? {
          dosage: Math.max(0, Math.min(2, dosage / totalWeight)),
          quality: Math.min(1, totalWeight / availableTags.length),
          tagsUsed: availableTags.length
        }
      : null;
  }

  countEffectAlleles(variant, effectAllele) {
    let count = 0;
    if (variant.allele1 === effectAllele) count++;
    if (variant.allele2 === effectAllele) count++;
    return count;
  }

  clearCache() {
    this.cache.clear();
  }
}

export async function createImputer(duckdb, userDNA, options = {}) {
  return new LocalImputer(duckdb, {
    ...options,
    population: options.population || 'EUR'
  });
}
