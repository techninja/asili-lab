#!/bin/bash
# Setup Beagle 5.4, Eagle2, and TOPMed reference panel for imputation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

source .env 2>/dev/null || true

BEAGLE_DIR="${BEAGLE_DIR:-./tools/beagle}"
EAGLE_DIR="${EAGLE_DIR:-./tools/eagle}"
LIFTOVER_DIR="${LIFTOVER_DIR:-./tools/liftover}"
REF_PANEL_DIR="${REF_PANEL_DIR:-./cache/topmed_reference}"

echo "======================================================================"
echo "Asili Imputation Setup (Eagle2 + Beagle 5.4 + TOPMed)"
echo "======================================================================"
echo "Beagle:    $BEAGLE_DIR"
echo "Eagle2:    $EAGLE_DIR"
echo "Liftover:  $LIFTOVER_DIR"
echo "Reference: $REF_PANEL_DIR"
echo "======================================================================"

mkdir -p "$BEAGLE_DIR"
mkdir -p "$EAGLE_DIR"
mkdir -p "$LIFTOVER_DIR"
mkdir -p "$REF_PANEL_DIR"

# --- Beagle 5.4 ---

if [ ! -f "$BEAGLE_DIR/beagle.jar" ]; then
    echo "Downloading Beagle 5.4..."
    wget -q --show-progress -O "$BEAGLE_DIR/beagle.jar" \
        "https://faculty.washington.edu/browning/beagle/beagle.22Jul22.46e.jar"
    echo "✓ Beagle downloaded"
else
    echo "✓ Beagle already installed"
fi

# --- Eagle2 ---

if [ ! -f "$EAGLE_DIR/eagle" ]; then
    echo ""
    echo "Downloading Eagle 2.4.1..."
    EAGLE_TAR="$EAGLE_DIR/eagle_v2.4.1.tar.gz"
    wget -q --show-progress -O "$EAGLE_TAR" \
        "https://storage.googleapis.com/broad-alkesgroup-public/Eagle/downloads/Eagle_v2.4.1.tar.gz"
    tar -xzf "$EAGLE_TAR" -C "$EAGLE_DIR" --strip-components=1
    rm "$EAGLE_TAR"
    chmod +x "$EAGLE_DIR/eagle"
    echo "✓ Eagle2 downloaded"
else
    echo "✓ Eagle2 already installed"
fi

# --- Genetic map (required by Eagle2) ---

if [ ! -f "$EAGLE_DIR/genetic_map_hg38_withX.txt.gz" ]; then
    echo "Downloading genetic map (hg38)..."
    wget -q --show-progress -O "$EAGLE_DIR/genetic_map_hg38_withX.txt.gz" \
        "https://storage.googleapis.com/broad-alkesgroup-public/Eagle/downloads/tables/genetic_map_hg38_withX.txt.gz"
    echo "✓ Genetic map downloaded"
else
    echo "✓ Genetic map already installed"
fi

# --- Liftover chain file (hg19 → hg38) ---

if [ ! -f "$LIFTOVER_DIR/hg19ToHg38.over.chain.gz" ]; then
    echo ""
    echo "Downloading hg19→hg38 liftover chain..."
    wget -q --show-progress -O "$LIFTOVER_DIR/hg19ToHg38.over.chain.gz" \
        "https://hgdownload.cse.ucsc.edu/goldenpath/hg19/liftOver/hg19ToHg38.over.chain.gz"
    echo "✓ Chain file downloaded"
else
    echo "✓ Liftover chain already installed"
fi

# --- hg38 reference FASTA (needed by CrossMap for VCF liftover) ---

if [ ! -f "$LIFTOVER_DIR/hg38.fa.gz" ] && [ ! -f "$LIFTOVER_DIR/hg38.fa" ]; then
    echo "Downloading hg38 reference genome (~1GB)..."
    wget -q --show-progress -O "$LIFTOVER_DIR/hg38.fa.gz" \
        "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/hg38.fa.gz"
    echo "✓ hg38 reference downloaded"
fi

if [ ! -f "$LIFTOVER_DIR/hg38.fa" ]; then
    echo "Decompressing hg38 reference (~3GB)..."
    gunzip -k "$LIFTOVER_DIR/hg38.fa.gz"
    echo "✓ hg38 reference decompressed"
else
    echo "✓ hg38 reference already installed"
fi

if [ ! -f "$LIFTOVER_DIR/hg38.fa.fai" ]; then
    echo "Indexing hg38 reference..."
    .venv/bin/python3 -c "import pysam; pysam.faidx('$LIFTOVER_DIR/hg38.fa')"
    echo "✓ hg38 reference indexed"
else
    echo "✓ hg38 index already exists"
fi

# --- Python dependencies ---

if [ -d ".venv" ]; then
    echo ""
    echo "Installing Python dependencies..."
    .venv/bin/pip install -q -r requirements.txt
    echo "✓ Python dependencies installed"
fi

# --- TOPMed reference panel ---

echo ""
echo "Checking TOPMed reference panel..."
echo "⚠️  This is ~150GB and will take 2-6 hours on first run"

# Check if download script exists
if [ -f "./scripts/download_topmed_panel.sh" ]; then
    ./scripts/download_topmed_panel.sh
else
    echo "❌ download_topmed_panel.sh not found"
    echo "   Place TOPMed VCFs as chr{1..22}.topmed.vcf.gz in $REF_PANEL_DIR"
    exit 1
fi

echo ""
echo "======================================================================"
echo "✅ Setup complete!"
echo "======================================================================"
echo ""
echo "Installed:"
echo "  Beagle 5.4:  $BEAGLE_DIR/beagle.jar"
echo "  Eagle 2.4.1: $EAGLE_DIR/eagle"
echo "  Genetic map: $EAGLE_DIR/genetic_map_hg38_withX.txt.gz"
echo "  Liftover:  $LIFTOVER_DIR/hg19ToHg38.over.chain.gz"
echo "  hg38 ref:  $LIFTOVER_DIR/hg38.fa.gz"
echo "  TOPMed:    $REF_PANEL_DIR"
echo ""
echo "Next steps:"
echo "  pnpm imputation optimize-panel  # One-time: convert VCF→BCF for speed"
echo "  pnpm imputation impute          # Run imputation"
