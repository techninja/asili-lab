#!/bin/bash
#
# Download and extract ancestry-stratified allele frequencies from
# 1000 Genomes Phase 3 whole-genome sites VCF.
#
# The sites VCF has INFO fields: EUR_AF, AFR_AF, EAS_AF, SAS_AF, AMR_AF
#
# Output: data_out/ancestry_af.tsv
#
# Usage:
#   bash scripts/extract-1kg-ancestry-af.sh
#
set -euo pipefail

# Source .env for LARGE_TMP
if [ -f "$(dirname "$0")/../.env" ]; then
    export $(grep -v '^#' "$(dirname "$0")/../.env" | grep '=' | xargs)
fi

OUTPUT_DIR="data_out"
OUTPUT_TSV="$OUTPUT_DIR/ancestry_af.tsv"
CACHE_DIR="${LARGE_TMP:-/media/techninja/gnomad/temp}/1kg_sites"
SITES_URL="https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/ALL.wgs.phase3_shapeit2_mvncall_integrated_v5c.20130502.sites.vcf.gz"
SITES_TBI="${SITES_URL}.tbi"
SITES_VCF="$CACHE_DIR/1kg_phase3_sites.vcf.gz"
SITES_IDX="$CACHE_DIR/1kg_phase3_sites.vcf.gz.tbi"

echo ""
echo "🌍 1000 Genomes Phase 3 ancestry-stratified allele frequencies"
echo ""

if [ -f "$OUTPUT_TSV" ]; then
    LINES=$(wc -l < "$OUTPUT_TSV")
    echo "⚠️  $OUTPUT_TSV already exists ($LINES lines)"
    echo "   Delete it to regenerate, or run:"
    echo "   pnpm pgs ancestry-norms $OUTPUT_TSV"
    exit 0
fi

mkdir -p "$CACHE_DIR"

# Download sites VCF if needed
if [ ! -f "$SITES_VCF" ]; then
    echo "📥 Downloading 1000 Genomes Phase 3 sites VCF (~1.5 GB)..."
    echo "   This is a one-time download."
    curl -L --progress-bar "$SITES_URL" -o "$SITES_VCF"
    curl -sL "$SITES_TBI" -o "$SITES_IDX"
    echo "   ✓ Downloaded"
fi

echo ""
echo "⏳ Extracting superpopulation allele frequencies..."

# Check that the VCF has the expected INFO fields
HAS_EUR=$(bcftools view -h "$SITES_VCF" 2>/dev/null | grep -c "EUR_AF" || true)
if [ "$HAS_EUR" -eq 0 ]; then
    echo "❌ Sites VCF does not contain EUR_AF INFO field"
    echo "   This may not be the correct file."
    exit 1
fi

# Extract: variant_id + 5 superpopulation AFs
# Include all variant types on autosomes (chr 1-22)
# Multiallelic sites produce one row per ALT with comma-separated AFs;
# bcftools %ALT outputs all ALTs joined by comma for multiallelics,
# so we use -u (--allow-undef-tags) to handle missing per-allele AFs.
bcftools query \
    -f '%CHROM:%POS:%REF:%ALT\t%INFO/EUR_AF\t%INFO/AFR_AF\t%INFO/EAS_AF\t%INFO/SAS_AF\t%INFO/AMR_AF\n' \
    "$SITES_VCF" 2>/dev/null \
    | awk -F'\t' '
        BEGIN { OFS="\t"; print "variant_id","af_eur","af_afr","af_eas","af_sas","af_amr" }
        $1 ~ /^[0-9]+:/ {
            # Skip rows with comma-separated ALTs (multiallelic VCF records)
            # These have comma-separated AFs that need special handling
            if ($1 !~ /,/ && $2 !~ /,/) print
        }
    ' \
    > "$OUTPUT_TSV"

TOTAL=$(( $(wc -l < "$OUTPUT_TSV") - 1 ))
SIZE=$(du -h "$OUTPUT_TSV" | cut -f1)
echo ""
echo "✅ Extracted $TOTAL variants with ancestry AFs ($SIZE)"
echo "   Output: $OUTPUT_TSV"
echo ""
echo "Next step:"
echo "   pnpm pgs ancestry-norms $OUTPUT_TSV"
echo ""
