/**
 * .asili archive builder — shared by DNA export and trait pack export.
 *
 * Splits a parquet file by `chr` column into per-chromosome parquets,
 * writes a manifest.json, and bundles everything into a .asili tar.
 *
 * Chromosome naming: 1-22 → chr1..chr22, 23 → chrX, 24 → chrY, 25 → chrMT
 */

import { execSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, statSync } from 'fs';
import path from 'path';

const CHR_NAMES = { 23: 'X', 24: 'Y', 25: 'MT' };
const chrLabel = n => CHR_NAMES[n] || String(n);

/**
 * Build a .asili tar archive from a single parquet file.
 *
 * @param {object} opts
 * @param {string} opts.inputPath   — source parquet file
 * @param {string} opts.outputPath  — destination .asili file
 * @param {string} opts.format      — archive format identifier (e.g. 'asili-trait-v1', 'asili-unified-v1')
 * @param {object} [opts.meta]      — extra fields merged into manifest.json
 * @param {string} [opts.statsQuery] — optional DuckDB SQL returning per-chr stats columns beyond `chr` and `variants`
 * @returns {{ totalVariants: number, chromosomes: object }}
 */
export function buildAsiliArchive({ inputPath, outputPath, format, meta = {}, statsQuery }) {
  const tmpDir = outputPath + '_tmp';
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Get per-chromosome variant counts (and optional extra columns)
    const sql = statsQuery ||
      `SELECT chr, COUNT(*) as variants FROM '${inputPath}' WHERE chr IS NOT NULL GROUP BY chr ORDER BY chr`;
    const statsJson = execSync(`duckdb -json -c "${sql}"`, {
      encoding: 'utf8', maxBuffer: 100 * 1024 * 1024
    });
    const stats = JSON.parse(statsJson);

    const chromosomes = {};
    let totalVariants = 0;

    for (const row of stats) {
      const chr = Number(row.chr);
      if (!chr) continue;
      const label = chrLabel(chr);
      const file = `chr${label}.parquet`;

      execSync(
        `duckdb -c "COPY (SELECT * FROM '${inputPath}' WHERE chr = ${chr} ORDER BY pos, allele_key) TO '${path.join(tmpDir, file)}' (FORMAT PARQUET, COMPRESSION ZSTD)"`,
        { maxBuffer: 100 * 1024 * 1024 }
      );

      const chrMeta = { file, variants: Number(row.variants) };
      // Carry through any extra stats columns
      for (const [k, v] of Object.entries(row)) {
        if (k !== 'chr' && k !== 'variants') chrMeta[k] = v;
      }
      chromosomes[label] = chrMeta;
      totalVariants += chrMeta.variants;
    }

    const manifest = {
      format,
      totalVariants,
      chromosomes,
      createdAt: new Date().toISOString(),
      ...meta
    };

    writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const files = ['manifest.json', ...Object.values(chromosomes).map(c => c.file)];
    execSync(`tar cf "${outputPath}" ${files.join(' ')}`, { cwd: tmpDir });

    return { totalVariants, chromosomes };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Return human-readable size string for a file */
export function fileSizeMB(filePath) {
  return (statSync(filePath).size / 1e6).toFixed(0);
}
