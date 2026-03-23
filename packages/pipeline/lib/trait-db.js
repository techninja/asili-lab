import { getConnection } from './shared-db.js';
import { readFileSync } from 'fs';
import crypto from 'crypto';
import { runMigrations } from './migrate.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = path.join(__dirname, '../trait_overrides.json');

let traitOverrides = null;
function getOverrides() {
  if (!traitOverrides) {
    try {
      traitOverrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    } catch {
      traitOverrides = {};
    }
  }
  return traitOverrides;
}

function calculateMetadataHash(override) {
  const metadata = {
    unit: override.unit || null,
    emoji: override.emoji || null,
    trait_type: override.trait_type || null,
    editorial_name: override.editorial_name || null,
    editorial_description: override.editorial_description || null,
    phenotype_mean: override.phenotype_mean || null,
    phenotype_sd: override.phenotype_sd || null,
    reference_population: override.reference_population || null
  };
  const str = JSON.stringify(metadata, Object.keys(metadata).sort());
  return crypto.createHash('sha256').update(str).digest('hex');
}

class TraitMetadataDB {
  constructor() {
    this.initialized = false;
  }

  async getConnection() {
    return await getConnection();
  }

  async init() {
    if (this.initialized) return;
    await runMigrations();
    this.initialized = true;
  }

  async upsertTrait(traitId, data) {
    await this.init();
    const conn = await this.getConnection();
    const now = new Date().toISOString();

    // Merge with overrides
    const overrides = getOverrides();
    const override = overrides[traitId] || {};

    const mergedData = {
      ...data,
      unit: override.unit || null,
      emoji: override.emoji || null,
      trait_type: override.trait_type || null,
      editorial_name: override.editorial_name || null,
      editorial_description: override.editorial_description || null,
      phenotype_mean: override.phenotype_mean || null,
      phenotype_sd: override.phenotype_sd || null,
      reference_population: override.reference_population || null,
      metadata_hash: calculateMetadataHash(override)
    };

    return new Promise((resolve, reject) => {
      const stmt = conn.prepare(`
        INSERT INTO traits (
          trait_id, name, description, categories, 
          expected_variants, estimated_unique_variants,
          unit, emoji, trait_type, editorial_name, editorial_description,
          phenotype_mean, phenotype_sd, reference_population, metadata_hash,
          last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
        ON CONFLICT (trait_id) DO UPDATE SET 
          name=EXCLUDED.name, 
          description=COALESCE(EXCLUDED.description, traits.description), 
          categories=COALESCE(EXCLUDED.categories, traits.categories), 
          expected_variants=COALESCE(EXCLUDED.expected_variants, traits.expected_variants), 
          estimated_unique_variants=COALESCE(EXCLUDED.estimated_unique_variants, traits.estimated_unique_variants),
          unit=COALESCE(EXCLUDED.unit, traits.unit),
          emoji=COALESCE(EXCLUDED.emoji, traits.emoji),
          trait_type=COALESCE(EXCLUDED.trait_type, traits.trait_type),
          editorial_name=COALESCE(EXCLUDED.editorial_name, traits.editorial_name),
          editorial_description=COALESCE(EXCLUDED.editorial_description, traits.editorial_description),
          phenotype_mean=COALESCE(EXCLUDED.phenotype_mean, traits.phenotype_mean),
          phenotype_sd=COALESCE(EXCLUDED.phenotype_sd, traits.phenotype_sd),
          reference_population=COALESCE(EXCLUDED.reference_population, traits.reference_population),
          metadata_hash=EXCLUDED.metadata_hash,
          last_updated=EXCLUDED.last_updated
      `);
      stmt.run(
        traitId,
        data.name,
        data.description ?? null,
        data.categories ?? '',
        data.expected_variants ?? null,
        data.estimated_unique_variants ?? null,
        mergedData.unit,
        mergedData.emoji,
        mergedData.trait_type,
        mergedData.editorial_name,
        mergedData.editorial_description,
        mergedData.phenotype_mean,
        mergedData.phenotype_sd,
        mergedData.reference_population,
        mergedData.metadata_hash,
        now,
        err => {
          stmt.finalize();
          err ? reject(err) : resolve();
        }
      );
    });
  }

  async getAllTraits() {
    await this.init();
    const conn = await this.getConnection();
    return new Promise((resolve, reject) => {
      conn.all('SELECT * FROM traits ORDER BY name', (err, rows) =>
        err ? reject(err) : resolve(rows)
      );
    });
  }

  async addTraitPGS(traitId, pgsId, performanceWeight = 0.5) {
    await this.init();
    const conn = await this.getConnection();
    return new Promise((resolve, reject) => {
      const stmt = conn.prepare(
        `INSERT INTO trait_pgs VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET performance_weight=EXCLUDED.performance_weight`
      );
      stmt.run(traitId, pgsId, performanceWeight, err => {
        stmt.finalize();
        err ? reject(err) : resolve();
      });
    });
  }

  async addExcludedPGS(traitId, pgsId, reason, method, weightType) {
    await this.init();
    const conn = await this.getConnection();
    return new Promise((resolve, reject) => {
      const stmt = conn.prepare(
        `INSERT INTO trait_excluded_pgs VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET reason=EXCLUDED.reason`
      );
      stmt.run(
        traitId,
        pgsId,
        reason,
        method ?? null,
        weightType ?? null,
        err => {
          stmt.finalize();
          err ? reject(err) : resolve();
        }
      );
    });
  }

  async getTraitPGS(traitId) {
    await this.init();
    const conn = await this.getConnection();
    return new Promise((resolve, reject) => {
      conn.all(
        'SELECT pgs_id, performance_weight FROM trait_pgs WHERE trait_id = ?',
        [traitId],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
  }

  async getExcludedPGS(traitId) {
    await this.init();
    const conn = await this.getConnection();
    return new Promise((resolve, reject) => {
      conn.all(
        'SELECT * FROM trait_excluded_pgs WHERE trait_id = ?',
        [traitId],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
  }

  async deleteTrait(traitId) {
    await this.init();
    const conn = await this.getConnection();
    await new Promise((resolve, reject) => {
      conn.run('DELETE FROM trait_pgs WHERE trait_id = ?', [traitId], err =>
        err ? reject(err) : resolve()
      );
    });
    await new Promise((resolve, reject) => {
      conn.run(
        'DELETE FROM trait_excluded_pgs WHERE trait_id = ?',
        [traitId],
        err => (err ? reject(err) : resolve())
      );
    });
    await new Promise((resolve, reject) => {
      conn.run('DELETE FROM traits WHERE trait_id = ?', [traitId], err =>
        err ? reject(err) : resolve()
      );
    });
  }

  async close() {
    // Don't close - shared connection is managed by shared-db.js
  }
}

const traitDB = new TraitMetadataDB();

export async function upsertTrait(traitId, data) {
  return traitDB.upsertTrait(traitId, data);
}

export async function getAllTraits() {
  return traitDB.getAllTraits();
}

export async function addTraitPGS(traitId, pgsId, performanceWeight) {
  return traitDB.addTraitPGS(traitId, pgsId, performanceWeight);
}

export async function addExcludedPGS(
  traitId,
  pgsId,
  reason,
  method,
  weightType
) {
  return traitDB.addExcludedPGS(traitId, pgsId, reason, method, weightType);
}

export async function getTraitPGS(traitId) {
  return traitDB.getTraitPGS(traitId);
}

export async function getExcludedPGS(traitId) {
  return traitDB.getExcludedPGS(traitId);
}

export async function deleteTrait(traitId) {
  return traitDB.deleteTrait(traitId);
}
