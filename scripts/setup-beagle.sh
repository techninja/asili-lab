#!/bin/bash
# Setup Beagle 5.4 and 1000 Genomes reference panel for imputation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

source .env 2>/dev/null || true

BEAGLE_DIR="${BEAGLE_DIR:-./tools/beagle}"
REF_PANEL_DIR="${REF_PANEL_DIR:-./cache/1000g_reference}"

echo "======================================================================"
echo "Beagle 5.4 Imputation Setup"
echo "======================================================================"
echo "Beagle: $BEAGLE_DIR"
echo "Reference Panel: $REF_PANEL_DIR"
echo "======================================================================"

mkdir -p "$BEAGLE_DIR"
mkdir -p "$REF_PANEL_DIR"

# Download Beagle 5.4
if [ ! -f "$BEAGLE_DIR/beagle.jar" ]; then
    echo "Downloading Beagle 5.4..."
    wget -q --show-progress -O "$BEAGLE_DIR/beagle.jar" \
        "https://faculty.washington.edu/browning/beagle/beagle.22Jul22.46e.jar"
    echo "✓ Beagle downloaded"
else
    echo "✓ Beagle already installed"
fi

# Download 1000 Genomes Phase 3 reference panel (Beagle format)
echo ""
echo "Checking 1000 Genomes reference panel..."
echo "Note: This is ~50GB and will take time on first run"

BASE_URL="http://bochet.gcc.biostat.washington.edu/beagle/1000_Genomes_phase3_v5a/b37.vcf"

for CHR in {1..22}; do
    VCF_FILE="chr${CHR}.1kg.phase3.v5a.vcf.gz"
    
    if [ -f "$REF_PANEL_DIR/$VCF_FILE" ]; then
        echo "  ✓ chr${CHR}"
    else
        echo "  Downloading chr${CHR}..."
        wget -q --show-progress -O "$REF_PANEL_DIR/$VCF_FILE" \
            "$BASE_URL/$VCF_FILE"
    fi
done

echo ""
echo "======================================================================"
echo "✅ Setup complete!"
echo "======================================================================"
echo ""
echo "Next steps:"
echo "  1. Convert user DNA to BCF: pnpm imputation prepare-user <file>"
echo "  2. Run imputation: pnpm imputation impute-user <user_id>"
echo "  3. Calculate scores: pnpm imputation score <user_id>"
