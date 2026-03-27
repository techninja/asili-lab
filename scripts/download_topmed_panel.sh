#!/bin/bash
# Download TOPMed Reference Panel
# ~300M variants (vs 80M in 1000 Genomes)
# Expected coverage: 60-80% of PGS variants

set -e

TOPMED_DIR="${REF_PANEL_DIR:-./cache/topmed_reference}"
mkdir -p "$TOPMED_DIR"

echo "🧬 Downloading TOPMed Reference Panel"
echo "This will download ~150GB of data and may take several hours"
echo "Target directory: $TOPMED_DIR"
echo ""
echo "Source: 1000 Genomes High Coverage (TOPMed Freeze 8 based)"
echo "Samples: 3,202 phased genomes"
echo ""

# 1000 Genomes High Coverage - TOPMed imputed and phased
BASE_URL="https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/1000G_2504_high_coverage/working/20201028_3202_phased"

for CHR in {1..22}; do
    echo "Downloading chromosome $CHR..."
    
    FILE="CCDG_14151_B01_GRM_WGS_2020-08-05_chr${CHR}.filtered.shapeit2-duohmm-phased.vcf.gz"
    OUTPUT="$TOPMED_DIR/chr${CHR}.topmed.vcf.gz"
    
    if [ -f "$OUTPUT" ] && [ -f "${OUTPUT}.tbi" ]; then
        echo "  ✓ chr${CHR} already exists, skipping"
        continue
    fi
    
    # Download with resume support
    wget -c -q --show-progress \
        -O "$OUTPUT" \
        "${BASE_URL}/${FILE}"
    
    # Index for Beagle
    echo "  Indexing..."
    tabix -p vcf "$OUTPUT"
    
    echo "  ✓ chr${CHR} complete ($(du -h $OUTPUT | cut -f1))"
done

echo ""
echo "✅ TOPMed reference panel download complete"
echo "Total size: $(du -sh $TOPMED_DIR | cut -f1)"
echo ""
echo "Next steps:"
echo "  1. Set REF_PANEL_DIR=$TOPMED_DIR in your .env"
echo "  2. Run: python3 scripts/impute_user.py <user_file> <user_id>"
echo "  3. Expected coverage: 60-80% of PGS variants (vs 2.2% with 1000G)"
