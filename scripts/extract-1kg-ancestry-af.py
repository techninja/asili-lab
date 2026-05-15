#!/usr/bin/env python3
"""
Extract ancestry-stratified allele frequencies from 1000 Genomes Phase 3 VCFs.

Downloads the IGSR sample→superpopulation mapping, then computes per-population
AFs from individual genotypes using bcftools + numpy. Single pass per chromosome.

Output: data_out/ancestry_af.tsv
  variant_id  af_eur  af_afr  af_eas  af_sas  af_amr

Usage:
  python3 scripts/extract-1kg-ancestry-af.py [panel_dir]
"""
import sys
import os
import subprocess
import time
from pathlib import Path
from urllib.request import urlretrieve

PANEL_URL = "https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/integrated_call_samples_v3.20130502.ALL.panel"
POPS = ["EUR", "AFR", "EAS", "SAS", "AMR"]

def main():
    root = Path(__file__).resolve().parent.parent
    panel_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "cache" / "topmed_reference"
    output_tsv = root / "data_out" / "ancestry_af.tsv"
    panel_file = root / "data_out" / "1kg_sample_panel.tsv"

    if output_tsv.exists():
        lines = sum(1 for _ in open(output_tsv)) - 1
        print(f"\n⚠️  {output_tsv} already exists ({lines:,} variants)")
        print(f"   Delete it to regenerate, or run:")
        print(f"   pnpm pgs ancestry-norms {output_tsv}\n")
        return

    test_vcf = panel_dir / "chr1.1kg.phase3.v5a.vcf.gz"
    if not test_vcf.exists():
        print(f"❌ 1000 Genomes VCFs not found in {panel_dir}")
        print(f"   Expected: chr{{1-22}}.1kg.phase3.v5a.vcf.gz")
        sys.exit(1)

    # Download sample panel
    if not panel_file.exists():
        print("📥 Downloading 1000 Genomes sample panel...")
        urlretrieve(PANEL_URL, panel_file)

    # Parse sample→superpopulation mapping
    sample_pop = {}
    with open(panel_file) as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 3 and parts[2] in POPS:
                sample_pop[parts[0]] = parts[2]

    pop_counts = {p: sum(1 for v in sample_pop.values() if v == p) for p in POPS}
    print(f"\n🌍 1000 Genomes superpopulation samples:")
    for p in POPS:
        print(f"   {p}: {pop_counts[p]} samples")

    print(f"\n⏳ Computing per-population AFs from genotypes...")
    print(f"   Panel dir: {panel_dir}\n")

    total_variants = 0
    start = time.monotonic()

    with open(output_tsv, "w") as out:
        out.write("variant_id\t" + "\t".join(f"af_{p.lower()}" for p in POPS) + "\n")

        for chrom in range(1, 23):
            vcf = panel_dir / f"chr{chrom}.1kg.phase3.v5a.vcf.gz"
            if not vcf.exists():
                print(f"   ⚠️  Skipping chr{chrom} (not found)")
                continue

            chr_start = time.monotonic()

            # Get sample order from VCF header
            result = subprocess.run(
                ["bcftools", "query", "-l", str(vcf)],
                capture_output=True, text=True
            )
            samples = result.stdout.strip().split("\n")

            # Build population index masks
            pop_indices = {p: [] for p in POPS}
            for i, s in enumerate(samples):
                p = sample_pop.get(s)
                if p:
                    pop_indices[p].append(i)

            # Stream genotypes: variant_id + all GTs
            fmt = "%CHROM:%POS:%REF:%ALT" + "".join(f"[\\t%GT]" for _ in range(1)) + "\\n"
            proc = subprocess.Popen(
                ["bcftools", "query", "-f", f"%CHROM:%POS:%REF:%ALT[\\t%GT]\\n", str(vcf)],
                stdout=subprocess.PIPE, text=True, bufsize=1024*1024
            )

            chr_count = 0
            for line in proc.stdout:
                parts = line.rstrip("\n").split("\t")
                variant_id = parts[0]
                gts = parts[1:]

                # Compute AF per population: count alt alleles / (2 * n_samples)
                pop_afs = []
                for p in POPS:
                    alt_count = 0
                    total_alleles = 0
                    for idx in pop_indices[p]:
                        if idx < len(gts):
                            gt = gts[idx]
                            if gt == "." or gt == "./." or gt == ".|.":
                                continue
                            alleles = gt.replace("|", "/").split("/")
                            for a in alleles:
                                if a != ".":
                                    total_alleles += 1
                                    if a != "0":
                                        alt_count += 1
                    af = alt_count / total_alleles if total_alleles > 0 else 0
                    pop_afs.append(f"{af:.6f}")

                out.write(f"{variant_id}\t" + "\t".join(pop_afs) + "\n")
                chr_count += 1

            proc.wait()
            total_variants += chr_count
            elapsed = time.monotonic() - chr_start
            print(f"   chr{chrom}: {chr_count:,} variants ({elapsed:.0f}s)")

    elapsed = time.monotonic() - start
    size_mb = output_tsv.stat().st_size / (1024 * 1024)
    print(f"\n✅ Extracted {total_variants:,} variants with ancestry AFs ({size_mb:.1f} MB) in {elapsed:.0f}s")
    print(f"   Output: {output_tsv}")
    print(f"\nNext step:")
    print(f"   pnpm pgs ancestry-norms {output_tsv}\n")


if __name__ == "__main__":
    main()
