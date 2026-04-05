/**
 * PGS file format detection and harmonization utilities
 */

export const FORMAT_TYPES = {
  STANDARD_SNP: 'STANDARD_SNP',
  STANDARD_SNP_NO_RSID: 'STANDARD_SNP_NO_RSID',
  DOSAGE_WEIGHTS: 'DOSAGE_WEIGHTS',
  HLA_ALLELE: 'HLA_ALLELE',
  RSID_ONLY: 'RSID_ONLY',
  RSID_CHR: 'RSID_CHR',
  RSID_HARMONIZED: 'RSID_HARMONIZED'
};

/**
 * Detect PGS file format based on column headers.
 * Harmonized files (with hm_chr/hm_pos) are preferred — they provide
 * GRCh38 coordinates regardless of the original genome build.
 */
export function detectFormat(columns) {
  // Check dosage format first (more specific)
  if (
    columns.includes('chr_name') &&
    columns.includes('chr_position') &&
    columns.includes('dosage_0_weight') &&
    columns.includes('dosage_1_weight') &&
    columns.includes('dosage_2_weight')
  ) {
    return FORMAT_TYPES.DOSAGE_WEIGHTS;
  }

  // Harmonized GRCh38 files — detect BEFORE standard formats so we
  // always use hm_chr/hm_pos (hg38) instead of chr_position (often hg19)
  if (columns.includes('hm_chr') && columns.includes('hm_pos')) {
    return FORMAT_TYPES.RSID_HARMONIZED;
  }

  if (columns.includes('rsID') && columns.includes('is_haplotype')) {
    return FORMAT_TYPES.HLA_ALLELE;
  }

  if (
    columns.includes('chr_name') &&
    columns.includes('chr_position') &&
    columns.includes('rsID')
  ) {
    return FORMAT_TYPES.STANDARD_SNP;
  } else if (
    columns.includes('chr_name') &&
    columns.includes('chr_position') &&
    !columns.includes('rsID')
  ) {
    return FORMAT_TYPES.STANDARD_SNP_NO_RSID;
  } else if (
    columns.includes('rsID') &&
    !columns.includes('chr_name') &&
    !columns.includes('is_haplotype')
  ) {
    return FORMAT_TYPES.RSID_ONLY;
  } else if (
    columns.includes('rsID') &&
    columns.includes('chr_name') &&
    !columns.includes('chr_position')
  ) {
    return FORMAT_TYPES.RSID_CHR;
  }
  return null;
}

/**
 * Get column reference helper for DuckDB queries
 */
export function getColumnRef(columns, colName) {
  const idx = columns.indexOf(colName);
  return idx !== -1 ? `"${colName}"` : "''";
}

/**
 * Generate harmonized column expressions for DuckDB based on format type
 */
export function generateColumnExpressions(formatType, columns) {
  const getCol = colName => getColumnRef(columns, colName);

  switch (formatType) {
    case FORMAT_TYPES.DOSAGE_WEIGHTS: {
      const chrNameCol = getCol('chr_name');
      const chrPosCol = getCol('chr_position');
      const effectAlleleCol = getCol('effect_allele');
      const otherAlleleCol = getCol('other_allele');
      const dosage1Col = getCol('dosage_1_weight');

      return {
        variant_id: `CONCAT(REPLACE(${chrNameCol}, 'chr', ''), ':', COALESCE(${chrPosCol}::TEXT, ''), ':', ${effectAlleleCol}, ':', ${otherAlleleCol})`,
        chr_name: `REPLACE(${chrNameCol}, 'chr', '')`,
        chr_position: `TRY_CAST(${chrPosCol} AS BIGINT)`,
        effect_allele: effectAlleleCol,
        other_allele: otherAlleleCol,
        effect_weight: `TRY_CAST(${dosage1Col} AS DOUBLE)`
      };
    }

    case FORMAT_TYPES.STANDARD_SNP:
    case FORMAT_TYPES.STANDARD_SNP_NO_RSID: {
      const chrNameCol = getCol('chr_name');
      const chrPosCol = getCol('chr_position');
      const effectAlleleCol = getCol('effect_allele');
      const otherAlleleCol = getCol('other_allele');
      const effectWeightCol = getCol('effect_weight');

      const hasOtherAllele = columns.includes('other_allele');
      const variantId = hasOtherAllele
        ? `CONCAT(REPLACE(${chrNameCol}, 'chr', ''), ':', COALESCE(${chrPosCol}::TEXT, ''), ':', ${effectAlleleCol}, ':', ${otherAlleleCol})`
        : `CONCAT(REPLACE(${chrNameCol}, 'chr', ''), ':', COALESCE(${chrPosCol}::TEXT, ''), ':', ${effectAlleleCol})`;

      return {
        variant_id: variantId,
        chr_name: `REPLACE(${chrNameCol}, 'chr', '')`,
        chr_position: `TRY_CAST(${chrPosCol} AS BIGINT)`,
        effect_allele: effectAlleleCol,
        other_allele: hasOtherAllele ? otherAlleleCol : "''",
        effect_weight: `TRY_CAST(${effectWeightCol} AS DOUBLE)`
      };
    }

    case FORMAT_TYPES.HLA_ALLELE: {
      const rsIdCol = getCol('rsID');
      const effectAlleleCol = getCol('effect_allele');
      const effectWeightCol = getCol('effect_weight');

      return {
        variant_id: `CASE WHEN ${rsIdCol} IS NOT NULL AND ${rsIdCol} != '' THEN ${rsIdCol} ELSE ${effectAlleleCol} END`,
        chr_name: "''",
        chr_position: 'NULL',
        effect_allele: effectAlleleCol,
        other_allele: "''",
        effect_weight: `TRY_CAST(${effectWeightCol} AS DOUBLE)`
      };
    }

    case FORMAT_TYPES.RSID_HARMONIZED: {
      const hmChrCol = getCol('hm_chr');
      const hmPosCol = getCol('hm_pos');
      const effectAlleleCol = getCol('effect_allele');
      const otherAlleleCol = getCol('other_allele');
      const hmOtherAlleleCol = getCol('hm_inferOtherAllele');
      const effectWeightCol = getCol('effect_weight');

      const hasOtherAllele = columns.includes('other_allele');
      const hasHmOther = columns.includes('hm_inferOtherAllele');

      // Prefer explicit other_allele, fall back to hm_inferOtherAllele
      const otherExpr = hasOtherAllele
        ? `NULLIF(${otherAlleleCol}, '')`
        : hasHmOther
          ? `NULLIF(${hmOtherAlleleCol}, '')`
          : 'NULL';

      // variant_id: chr:pos:effect:other (drop rows where hm_pos is null/empty)
      const variantId = `CONCAT(
                REPLACE(${hmChrCol}, 'chr', ''), ':',
                ${hmPosCol}, ':',
                ${effectAlleleCol}, ':',
                COALESCE(${otherExpr}, '')
            )`;

      return {
        variant_id: variantId,
        chr_name: `REPLACE(${hmChrCol}, 'chr', '')`,
        chr_position: `TRY_CAST(${hmPosCol} AS BIGINT)`,
        effect_allele: effectAlleleCol,
        other_allele: otherExpr,
        effect_weight: `TRY_CAST(${effectWeightCol} AS DOUBLE)`,
        // Filter expression: only keep rows with valid hm_pos
        _filter: `${hmPosCol} IS NOT NULL AND ${hmPosCol} != '' AND ${hmPosCol} != '0'`
      };
    }

    case FORMAT_TYPES.RSID_ONLY:
    case FORMAT_TYPES.RSID_CHR:
    default: {
      const rsIdCol = getCol('rsID');
      const effectAlleleCol = getCol('effect_allele');
      const otherAlleleCol = getCol('other_allele');
      const effectWeightCol = getCol('effect_weight');
      const chrNameCol =
        formatType === FORMAT_TYPES.RSID_CHR
          ? `REPLACE(${getCol('chr_name')}, 'chr', '')`
          : "''";

      return {
        variant_id: rsIdCol,
        chr_name: chrNameCol,
        chr_position: 'NULL',
        effect_allele: effectAlleleCol,
        other_allele: otherAlleleCol,
        effect_weight: `TRY_CAST(${effectWeightCol} AS DOUBLE)`
      };
    }
  }
}

/**
 * Generate DuckDB column definitions for CSV reading
 */
export function generateColumnDefinitions(_columns) {
  // No longer needed — DuckDB reads headers directly with header=true
  return null;
}

/**
 * Generate complete DuckDB INSERT statement for harmonized data
 */
export function generateInsertSQL(
  formatType,
  columns,
  dataPath,
  pgsId,
  config,
  traitName
) {
  const expressions = generateColumnExpressions(formatType, columns);
  const weightCol =
    formatType === FORMAT_TYPES.DOSAGE_WEIGHTS
      ? getColumnRef(columns, 'dosage_1_weight')
      : getColumnRef(columns, 'effect_weight');

  const hasOtherAllele = columns.includes('other_allele');
  const gnomadPath = process.env.GNOMAD_PARQUET_PATH;

  // If other_allele is missing and gnomAD is available, look it up
  if (
    !hasOtherAllele &&
    gnomadPath &&
    (formatType === FORMAT_TYPES.STANDARD_SNP ||
      formatType === FORMAT_TYPES.STANDARD_SNP_NO_RSID)
  ) {
    const chrNameCol = getColumnRef(columns, 'chr_name');
    const chrPosCol = getColumnRef(columns, 'chr_position');
    const effectAlleleCol = getColumnRef(columns, 'effect_allele');
    const effectWeightCol = getColumnRef(columns, 'effect_weight');

    return `
        INSERT INTO pgs_staging 
        SELECT 
            CASE 
                WHEN g.ref IS NOT NULL AND g.alt IS NOT NULL THEN
                    CONCAT(REPLACE(csv.${chrNameCol}, 'chr', ''), ':', COALESCE(csv.${chrPosCol}::TEXT, ''), ':', g.ref, ':', g.alt)
                ELSE
                    CONCAT(REPLACE(csv.${chrNameCol}, 'chr', ''), ':', COALESCE(csv.${chrPosCol}::TEXT, ''), ':', csv.${effectAlleleCol})
            END as variant_id,
            REPLACE(csv.${chrNameCol}, 'chr', '') as chr_name,
            TRY_CAST(csv.${chrPosCol} AS BIGINT) as chr_position,
            csv.${effectAlleleCol} as effect_allele,
            COALESCE(g.ref, '') as other_allele,
            TRY_CAST(csv.${effectWeightCol} AS DOUBLE) as effect_weight,
            '${pgsId}' as pgs_id,
            '${config.source_family || traitName}' as source_family,
            '${config.source_type || 'trait'}' as source_type,
            '${config.source_subtype || 'mondo'}' as source_subtype,
            ${config.weight || 1.0} as source_weight,
            'log_odds' as weight_type,
            '${formatType}' as format_type
        FROM read_csv('${dataPath}', delim='\\t', header=true, comment='#', all_varchar=true) csv
        LEFT JOIN read_parquet('${gnomadPath}') g 
            ON 'chr' || REPLACE(csv.${chrNameCol}, 'chr', '') = g.chr 
            AND TRY_CAST(csv.${chrPosCol} AS BIGINT) = g.pos
            AND csv.${effectAlleleCol} = g.alt
        WHERE csv.${effectAlleleCol} IS NOT NULL 
          AND csv.${effectAlleleCol} != ''
          AND csv.${weightCol} IS NOT NULL
          AND csv.${weightCol} != '';
    `;
  }

  // Original logic for files with other_allele or no gnomAD
  const extraFilter = expressions._filter ? `AND ${expressions._filter}` : '';
  return `
        INSERT INTO pgs_staging 
        SELECT 
            ${expressions.variant_id} as variant_id,
            ${expressions.chr_name} as chr_name,
            ${expressions.chr_position} as chr_position,
            ${expressions.effect_allele} as effect_allele,
            ${expressions.other_allele} as other_allele,
            ${expressions.effect_weight} as effect_weight,
            '${pgsId}' as pgs_id,
            '${config.source_family || traitName}' as source_family,
            '${config.source_type || 'trait'}' as source_type,
            '${config.source_subtype || 'mondo'}' as source_subtype,
            ${config.weight || 1.0} as source_weight,
            'log_odds' as weight_type,
            '${formatType}' as format_type
        FROM read_csv('${dataPath}', delim='\\t', header=true, comment='#', all_varchar=true)
        WHERE ${expressions.effect_allele} IS NOT NULL 
          AND ${expressions.effect_allele} != ''
          AND ${weightCol} IS NOT NULL
          AND ${weightCol} != ''
          ${extraFilter};
    `;
}
