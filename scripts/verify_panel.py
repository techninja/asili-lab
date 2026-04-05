#!/usr/bin/env python3
"""Quick verification of TOPMed reference panel — checks files exist and are readable."""
import subprocess
import sys
import os
from pathlib import Path

REF_PANEL_DIR = os.getenv('REF_PANEL_DIR', './cache/topmed_reference')

def main():
    print(f"\n🔍 Checking TOPMed panel in {REF_PANEL_DIR}\n")

    missing = []
    found_vcf = 0
    found_bcf = 0

    for chrom in range(1, 23):
        vcf = Path(f"{REF_PANEL_DIR}/chr{chrom}.topmed.vcf.gz")
        bcf = Path(f"{REF_PANEL_DIR}/chr{chrom}.topmed.bcf")

        if bcf.exists():
            found_bcf += 1
        elif vcf.exists():
            found_vcf += 1
        else:
            missing.append(chrom)

    if missing:
        print(f"❌ Missing chromosomes: {', '.join(str(c) for c in missing)}")
        print("\nRun: pnpm imputation setup")
        return 1

    print(f"✓ All 22 chromosomes present ({found_bcf} BCF, {found_vcf} VCF.gz)")

    # Quick readability check on chr22 (smallest)
    test_file = f"{REF_PANEL_DIR}/chr22.topmed.bcf" if found_bcf else f"{REF_PANEL_DIR}/chr22.topmed.vcf.gz"
    result = subprocess.run(
        ['bcftools', 'query', '-f', '%CHROM\n', '-r', 'chr22:16000000-16000100', test_file],
        capture_output=True, text=True
    )
    if result.returncode == 0 and result.stdout.strip():
        print("✓ Panel is readable (spot check passed)")
    else:
        print("⚠ Panel files exist but may be corrupted")

    if found_bcf < 22:
        print(f"\n💡 Run 'pnpm imputation optimize-panel' to convert {22 - found_bcf} VCFs to BCF for faster I/O")

    return 0

if __name__ == '__main__':
    sys.exit(main())
