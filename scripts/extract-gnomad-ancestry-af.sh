#!/bin/bash
#
# Download gnomAD v4.1 per-chromosome sites VCFs and extract
# ancestry-stratified allele frequencies.
#
# Populations extracted:
#   afr  - African/African-American
#   amr  - Admixed American
#   asj  - Ashkenazi Jewish
#   eas  - East Asian
#   fin  - Finnish
#   mid  - Middle Eastern
#   nfe  - Non-Finnish European
#   sas  - South Asian
#
# VCFs are cached on LARGE_TMP (~300GB total).
# Output TSV is ~3-5GB with just variant_id + 8 ancestry AFs.
#
# Usage:
#   bash scripts/extract-gnomad-ancestry-af.sh
#   bash scripts/extract-gnomad-ancestry-af.sh 22      # single chromosome
#
set -euo pipefail

# Source .env for LARGE_TMP
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
    export $(grep -v '^#' "$SCRIPT_DIR/../.env" | grep '=' | xargs)
fi

LARGE_TMP="${LARGE_TMP:-/tmp}"
CACHE_DIR="$LARGE_TMP/gnomad_v4_sites"
OUTPUT_TSV="data_out/ancestry_af.tsv"
BASE_URL="https://storage.googleapis.com/gcp-public-data--gnomad/release/4.1/vcf/genomes"
SINGLE_CHR="${1:-}"

POPS="afr amr asj eas fin mid nfe sas"
# Build bcftools query format: %INFO/AF_afr\t%INFO/AF_amr\t...
AF_FIELDS=$(echo $POPS | tr ' ' '\n' | sed 's/^/%INFO\/AF_/' | paste -sd'\t')

echo ""
echo "🧬 gnomAD v4.1 ancestry-stratified allele frequencies"
echo "   Cache: $CACHE_DIR"
echo "   Output: $OUTPUT_TSV"
echo "   Populations: $POPS"
echo ""

if [ -f "$OUTPUT_TSV" ] && [ -z "$SINGLE_CHR" ]; then
    LINES=$(wc -l < "$OUTPUT_TSV")
    echo "⚠️  $OUTPUT_TSV already exists ($LINES lines)"
    echo "   Delete it to regenerate, or run:"
    echo "   pnpm pgs ancestry-norms"
    exit 0
fi

mkdir -p "$CACHE_DIR"

# Write header
HEADER="variant_id"
for POP in $POPS; do
    HEADER="${HEADER}\taf_${POP}"
done
echo -e "$HEADER" > "$OUTPUT_TSV"

# Determine chromosomes to process
if [ -n "$SINGLE_CHR" ]; then
    CHROMS="$SINGLE_CHR"
else
    CHROMS="$(seq 1 22)"
fi

for CHR in $CHROMS; do
    VCF_NAME="gnomad.genomes.v4.1.sites.chr${CHR}.vcf.bgz"
    TBI_NAME="${VCF_NAME}.tbi"
    VCF_PATH="$CACHE_DIR/$VCF_NAME"
    TBI_PATH="$CACHE_DIR/$TBI_NAME"

    # Download VCF if not cached
    if [ ! -f "$VCF_PATH" ]; then
        echo "   📥 Downloading chr${CHR}..."
        curl -L --progress-bar "${BASE_URL}/${VCF_NAME}" -o "$VCF_PATH"
        curl -sL "${BASE_URL}/${TBI_NAME}" -o "$TBI_PATH"
    else
        SIZE=$(du -h "$VCF_PATH" | cut -f1)
        echo -n "   chr${CHR} (cached, $SIZE)..."
    fi

    # Extract ancestry AFs — stream through bcftools, skip multiallelics with commas
    START=$(date +%s)
    bcftools query \
        -f '%CHROM:%POS:%REF:%ALT\t%INFO/AF_afr\t%INFO/AF_amr\t%INFO/AF_asj\t%INFO/AF_eas\t%INFO/AF_fin\t%INFO/AF_mid\t%INFO/AF_nfe\t%INFO/AF_sas\n' \
        -i 'N_ALT=1' \
        "$VCF_PATH" 2>/dev/null \
        | sed 's/^chr//' \
        >> "$OUTPUT_TSV"

    END=$(date +%s)
    ELAPSED=$((END - START))

    # Count variants added for this chromosome
    echo " extracted (${ELAPSED}s)"
done

TOTAL=$(( $(wc -l < "$OUTPUT_TSV") - 1 ))
SIZE=$(du -h "$OUTPUT_TSV" | cut -f1)
echo ""
echo "✅ Extracted $TOTAL variants with ancestry AFs ($SIZE)"
echo "   Output: $OUTPUT_TSV"
echo ""
echo "Next step:"
echo "   pnpm pgs ancestry-norms"
echo ""
