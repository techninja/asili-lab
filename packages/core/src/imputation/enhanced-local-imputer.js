/**
 * Enhanced Local LD-based imputation engine
 * Supports array-specific panels and unified database
 */

import { Debug } from '../utils/debug.js';
import path from 'path';

export class EnhancedLocalImputer {
  constructor(duckdb, options = {}) {
    this.db = duckdb;
    this.population = options.population || 'EUR';
    this.minQuality = options.minQuality || 0.3;
    this.minMAF = options.minMAF || 0.01;
    this.dataPath = options.dataPath || '/data/imputation';
    this.useUnifiedDB = options.useUnifiedDB !== false;
    this.arrayType = options.arrayType || null; // Auto-detect if null
    this.cache = new Map();
  }

  async imputeVariants(userDNA, targetRSIDs, chromosome = null) {
    console.log('🔥🔥🔥 EnhancedLocalImputer.imputeVariants CALLED');
    console.log('🔥 targetRSIDs count:', targetRSIDs.length);
    console.log('🔥 userDNA count:', userDNA.length);
    console.log('🔥 useUnifiedDB:', this.useUnifiedDB);
    
    Debug.log(2, 'EnhancedLocalImputer', `Imputing ${targetRSIDs.length} variants for ${this.population}`);

    // Auto-detect array type if not specified
    if (!this.arrayType) {
      this.arrayType = await this.detectArrayType(userDNA);
      console.log('🔥 Detected array type:', this.arrayType);
    }

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
    
    console.log('🔥 Imputation complete:', imputed.length, 'imputed,', highQuality, 'high quality');
    console.log('🔥 Null results:', nullResults, ', Low quality:', lowQuality);

    Debug.log(2, 'EnhancedLocalImputer', `Imputed ${imputed.length} variants (high quality: ${highQuality})`);
    return imputed;
  }

  async detectArrayType(userDNA) {
    // Check for user-specific array by looking for individualId in manifest files
    const manifestPath = path.join(this.dataPath, 'manifests');
    
    try {
      const files = await import('fs/promises').then(fs => fs.readdir(manifestPath));
      
      // Look for manifest files matching pattern: {id}_{name}.positions.txt
      for (const file of files) {
        if (file.endsWith('.positions.txt') && file.includes('_')) {
          const arrayName = file.replace('.positions.txt', '');
          // Check if this array exists in the database
          const check = await new Promise((resolve) => {
            this.db.all(`SELECT COUNT(*) as cnt FROM imputation_panels WHERE array_type = '${arrayName}' LIMIT 1`, (err, rows) => {
              resolve(!err && rows && rows[0]?.cnt > 0);
            });
          });
          if (check) {
            Debug.log(2, 'EnhancedLocalImputer', `Using user-specific array: ${arrayName}`);
            return arrayName;
          }
        }
      }
    } catch (err) {
      Debug.log(2, 'EnhancedLocalImputer', `Array detection failed: ${err.message}`);
    }
    
    Debug.log(2, 'EnhancedLocalImputer', 'Falling back to generic array');
    return 'generic';
  }

  buildUserLookup(userDNA) {
    const lookup = new Map();
    console.log('🔥 Building user lookup from', userDNA.length, 'variants');
    
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
    return lookup;
  }

  async queryReferencePanel(targetRSIDs, chromosome = null) {
    if (this.useUnifiedDB) {
      return this.queryUnifiedDB(targetRSIDs, chromosome);
    } else {
      return this.queryLegacyPanels(targetRSIDs, chromosome);
    }
  }

  async queryUnifiedDB(targetRSIDs, chromosome = null) {
    const dbPath = path.join(this.dataPath, 'imputation.duckdb');
    
    Debug.log(2, 'EnhancedLocalImputer', `🔍 Querying unified DB: ${dbPath}`);

    try {
      // Attach database first
      await new Promise((resolve, reject) => {
        this.db.all(`ATTACH '${dbPath}' AS imputation_db (READ_ONLY)`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Normalize rsIDs and batch process
      const normalizedRSIDs = targetRSIDs.map(rsid => {
        if (rsid.match(/^\d+:\d+:/)) {
          const parts = rsid.split(':');
          return `chr${parts[0]}:${parts[1]}`;
        }
        if (rsid.match(/^\d+:\d+$/)) {
          const parts = rsid.split(':');
          return `chr${parts[0]}:${parts[1]}`;
        }
        return rsid;
      });
      
      // Process in batches of 10K to avoid query size limits
      const batchSize = 10000;
      const allResults = [];
      
      for (let i = 0; i < normalizedRSIDs.length; i += batchSize) {
        const batch = normalizedRSIDs.slice(i, i + batchSize);
        const rsidList = batch.map(r => `'${r}'`).join(',');
        const chrFilter = chromosome ? `AND chr = '${chromosome}'` : '';
        
        const query = `
          SELECT chr, pos, rsid, ref, alt, maf, tag_snps, tag_r2, haplotype_probs, imputation_quality
          FROM imputation_db.imputation_panels
          WHERE array_type = '${this.arrayType}'
            AND population = '${this.population}'
            AND rsid IN (${rsidList})
            AND maf >= ${this.minMAF}
            AND imputation_quality >= ${this.minQuality}
            ${chrFilter}
        `;

        const rows = await new Promise((resolve, reject) => {
          this.db.all(query, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          });
        });
        
        allResults.push(...rows);
        
        if (i % 50000 === 0 && i > 0) {
          Debug.log(2, 'EnhancedLocalImputer', `Processed ${i}/${normalizedRSIDs.length} queries...`);
        }
      }

      // Detach database
      await new Promise((resolve) => {
        this.db.all('DETACH imputation_db', () => resolve());
      });

      Debug.log(2, 'EnhancedLocalImputer', `✅ Found ${allResults.length} variants in unified DB`);
      return this.sanitizeResults(allResults);
      
    } catch (err) {
      Debug.log(1, 'EnhancedLocalImputer', `❌ Unified DB query failed: ${err.message}`);
      // Try to detach on error
      await new Promise((resolve) => {
        this.db.all('DETACH imputation_db', () => resolve());
      });
      // Fallback to legacy panels
      return this.queryLegacyPanels(targetRSIDs, chromosome);
    }
  }

  async queryLegacyPanels(targetRSIDs, chromosome = null) {
    const filePattern = chromosome 
      ? `${this.dataPath}/1000g_${this.population.toLowerCase()}_chr${chromosome}.parquet`
      : `${this.dataPath}/1000g_${this.population.toLowerCase()}_chr*.parquet`;

    Debug.log(2, 'EnhancedLocalImputer', `🔍 Query pattern: ${filePattern}`);

    const normalizedRSIDs = targetRSIDs.map(rsid => {
      if (rsid.match(/^\d+:\d+:/)) {
        const parts = rsid.split(':');
        return `chr${parts[0]}:${parts[1]}`;
      }
      if (rsid.match(/^\d+:\d+$/)) {
        const parts = rsid.split(':');
        return `chr${parts[0]}:${parts[1]}`;
      }
      return rsid;
    });
    
    const rsidList = normalizedRSIDs.map(r => `'${r}'`).join(',');
    
    const query = `
      SELECT chr, pos, rsid, ref, alt, maf, tag_snps, tag_r2, haplotype_probs, imputation_quality
      FROM read_parquet('${filePattern}')
      WHERE rsid IN (${rsidList}) AND maf >= ${this.minMAF} AND imputation_quality >= ${this.minQuality}
    `;

    return new Promise((resolve, reject) => {
      this.db.all(query, (err, rows) => {
        if (err) {
          Debug.log(1, 'EnhancedLocalImputer', `❌ Query failed: ${err.message}`);
          reject(err);
        } else {
          Debug.log(2, 'EnhancedLocalImputer', `✅ Found ${rows.length} variants in legacy panels`);
          resolve(this.sanitizeResults(rows));
        }
      });
    });
  }

  sanitizeResults(rows) {
    return rows.map(row => ({
      ...row,
      pos: Number(row.pos),
      chr: row.chr?.toString(),
      tag_snps: Array.isArray(row.tag_snps) ? row.tag_snps : [],
      tag_r2: Array.isArray(row.tag_r2) ? row.tag_r2 : []
    }));
  }

  calculateDosage(variant, userLookup) {
    if (!variant.tag_snps || variant.tag_snps.length === 0) {
      return null;
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
    
    return totalWeight > 0 ? {
      dosage: Math.max(0, Math.min(2, dosage / totalWeight)),
      quality: Math.min(1, totalWeight / availableTags.length),
      tagsUsed: availableTags.length
    } : null;
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

export async function createEnhancedImputer(duckdb, userDNA, options = {}) {
  return new EnhancedLocalImputer(duckdb, {
    ...options,
    population: options.population || 'EUR'
  });
}
