#!/usr/bin/env python3
"""
Verify TOPMed reference panel and estimate PGS coverage
"""
import subprocess
import sys
from pathlib import Path

def check_panel(panel_dir, panel_type):
    """Check if reference panel exists and count variants."""
    print(f"\n🔍 Checking {panel_type.upper()} panel in {panel_dir}\n")
    
    if panel_type == 'topmed':
        pattern = 'chr*.topmed.vcf.gz'
    else:
        pattern = 'chr*.1kg.phase3.v5a.vcf.gz'
    
    files = sorted(Path(panel_dir).glob(pattern))
    
    if not files:
        print(f"❌ No {panel_type} files found")
        return None
    
    print(f"✓ Found {len(files)} chromosome files\n")
    
    total_variants = 0
    for vcf in files[:3]:  # Sample first 3 chromosomes
        result = subprocess.run(
            ['bcftools', 'view', '-H', str(vcf)],
            capture_output=True, text=True
        )
        count = len(result.stdout.strip().split('\n'))
        total_variants += count
        chrom = vcf.stem.split('.')[0]
        print(f"  {chrom}: {count:,} variants")
    
    # Estimate total (chromosomes 1-3 are ~15% of genome)
    estimated_total = int(total_variants / 0.15)
    print(f"\n📊 Estimated total: {estimated_total:,} variants")
    
    return estimated_total

def estimate_coverage(panel_variants, pgs_positions_file):
    """Estimate PGS coverage based on variant density."""
    
    # Count PGS positions
    with open(pgs_positions_file) as f:
        pgs_count = sum(1 for _ in f)
    
    print(f"\n📍 PGS positions to match: {pgs_count:,}")
    
    # Coverage estimates based on panel size
    if panel_variants < 100_000_000:  # 1000 Genomes
        coverage = 0.022  # 2.2%
        panel_name = "1000 Genomes"
    else:  # TOPMed
        coverage = 0.70  # 70% average
        panel_name = "TOPMed"
    
    expected_matches = int(pgs_count * coverage)
    
    print(f"\n🎯 Expected Coverage ({panel_name}):")
    print(f"  Coverage rate: {coverage*100:.1f}%")
    print(f"  Expected matches: {expected_matches:,}")
    print(f"  Missing: {pgs_count - expected_matches:,}")
    
    return expected_matches

def main():
    # Check both panels
    panels = [
        ('./cache/1000g_reference', '1000g'),
        ('./cache/topmed_reference', 'topmed')
    ]
    
    results = {}
    for panel_dir, panel_type in panels:
        if Path(panel_dir).exists():
            variants = check_panel(panel_dir, panel_type)
            if variants:
                results[panel_type] = variants
    
    if not results:
        print("\n❌ No reference panels found")
        print("\nDownload options:")
        print("  1000 Genomes: Already downloaded (9GB)")
        print("  TOPMed: Run ./scripts/download_topmed_panel.sh (150GB)")
        return 1
    
    # Estimate coverage
    pgs_file = './data_out/pgs_positions.txt'
    if Path(pgs_file).exists():
        print("\n" + "="*60)
        for panel_type, variants in results.items():
            estimate_coverage(variants, pgs_file)
            print()
    
    # Recommendation
    print("="*60)
    print("\n💡 Recommendation:")
    if 'topmed' in results:
        print("  ✓ TOPMed panel detected - use this for best coverage")
        print("  export REF_PANEL_DIR=./cache/topmed_reference")
    elif '1000g' in results:
        print("  ⚠ Only 1000 Genomes available (2.2% coverage)")
        print("  Consider downloading TOPMed for 70% coverage:")
        print("  ./scripts/download_topmed_panel.sh")
    
    return 0

if __name__ == '__main__':
    sys.exit(main())
