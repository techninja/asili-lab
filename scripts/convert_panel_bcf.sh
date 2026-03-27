#!/bin/bash
# Convert TOPMed reference panel VCF.gz to BCF for faster Eagle2/Beagle reading.
# One-time operation. BCF is ~3x faster for random access.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

source .env 2>/dev/null || true

REF_PANEL_DIR="${REF_PANEL_DIR:-./cache/topmed_reference}"
THREADS="${1:-4}"

echo "Converting TOPMed panel to BCF (${THREADS} threads)..."
echo "Directory: $REF_PANEL_DIR"
echo ""

converted=0
skipped=0

for CHR in {1..22}; do
    vcf="$REF_PANEL_DIR/chr${CHR}.topmed.vcf.gz"
    bcf="$REF_PANEL_DIR/chr${CHR}.topmed.bcf"

    if [ ! -f "$vcf" ]; then
        echo "  ✗ chr${CHR} VCF not found, skipping"
        continue
    fi

    if [ -f "$bcf" ]; then
        echo "  ✓ chr${CHR} (already converted)"
        skipped=$((skipped + 1))
        continue
    fi

    echo "  Converting chr${CHR}..."
    bcftools view --threads "$THREADS" -O b -o "$bcf" "$vcf"
    bcftools index --threads "$THREADS" "$bcf"
    converted=$((converted + 1))
done

echo ""
echo "✅ Done: $converted converted, $skipped already existed"
echo "💡 Eagle2 and Beagle will automatically use BCF files for faster I/O"
