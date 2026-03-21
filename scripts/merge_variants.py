#!/usr/bin/env python3
"""
Merge genotyped variants (from JSON) with imputed variants (from Parquet)
into a single unified Parquet file for faster processing.
"""
import sys
import json
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path

def merge_variants(json_file, imputed_file, output_file):
    """Merge genotyped and imputed variants into single Parquet."""
    
    print(f"Loading genotyped variants from {json_file}...")
    with open(json_file) as f:
        data = json.load(f)
    
    genotyped_variants = []
    genotyped_dosages = []
    genotyped_flags = []  # Track which are genotyped
    
    for variant in data['variants']:
        chrom = variant.get('chromosome', '')
        pos = variant.get('position', 0)
        allele1 = variant.get('allele1', '')
        allele2 = variant.get('allele2', '')
        
        # Skip invalid
        if chrom not in [str(i) for i in range(1, 23)] + ['X', 'Y', 'MT']:
            continue
        if allele1 not in {'A', 'C', 'G', 'T'} or allele2 not in {'A', 'C', 'G', 'T'}:
            continue
        
        # Create variant ID (use sorted alleles for consistency)
        ref, alt = sorted([allele1, allele2])
        variant_id = f"{chrom}:{pos}:{ref}:{alt}"
        
        # Calculate dosage (0, 1, or 2 for genotyped)
        if allele1 == allele2:
            dosage = 0.0 if allele1 == ref else 2.0
        else:
            dosage = 1.0  # Heterozygous
        
        genotyped_variants.append(variant_id)
        genotyped_dosages.append(dosage)
        genotyped_flags.append(False)  # False = genotyped (not imputed)
    
    print(f"  ✓ Loaded {len(genotyped_variants):,} genotyped variants")
    
    # Load imputed variants
    print(f"Loading imputed variants from {imputed_file}...")
    imputed_table = pq.read_table(imputed_file)
    imputed_variants = imputed_table['variant_id'].to_pylist()
    imputed_dosages = imputed_table['genotype_dosage'].to_pylist()
    print(f"  ✓ Loaded {len(imputed_variants):,} imputed variants")
    
    # Create position-based lookup for genotyped variants
    genotyped_positions = set()
    for vid in genotyped_variants:
        parts = vid.split(':')
        if len(parts) >= 2:
            genotyped_positions.add(f"{parts[0]}:{parts[1]}")
    
    # Filter imputed variants to exclude positions already in genotyped
    # (genotyped data is more accurate)
    filtered_imputed_variants = []
    filtered_imputed_dosages = []
    filtered_imputed_flags = []
    
    for vid, dosage in zip(imputed_variants, imputed_dosages):
        parts = vid.split(':')
        if len(parts) >= 2:
            pos_key = f"{parts[0]}:{parts[1]}"
            if pos_key not in genotyped_positions:
                filtered_imputed_variants.append(vid)
                filtered_imputed_dosages.append(dosage)
                filtered_imputed_flags.append(True)  # True = imputed
    
    print(f"  ✓ Filtered to {len(filtered_imputed_variants):,} unique imputed positions")
    
    # Merge
    all_variants = genotyped_variants + filtered_imputed_variants
    all_dosages = genotyped_dosages + filtered_imputed_dosages
    all_imputed_flags = genotyped_flags + filtered_imputed_flags
    
    print(f"Creating unified Parquet with {len(all_variants):,} total variants...")
    
    # Extract chr (int8) and pos (int32) from variant_id for fast integer JOINs
    all_chr = []
    all_pos = []
    chr_map = {'X': 23, 'Y': 24, 'MT': 25}
    for vid in all_variants:
        parts = vid.split(':')
        c = parts[0] if len(parts) >= 1 else '0'
        p = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0
        all_chr.append(chr_map.get(c, int(c) if c.isdigit() else 0))
        all_pos.append(p)

    table = pa.table({
        'variant_id': pa.array(all_variants),
        'genotype_dosage': pa.array(all_dosages, type=pa.float32()),
        'imputed': pa.array(all_imputed_flags, type=pa.bool_()),
        'chr': pa.array(all_chr, type=pa.int8()),
        'pos': pa.array(all_pos, type=pa.int32())
    })
    
    pq.write_table(table, output_file, compression='zstd')
    
    print(f"✓ Unified file created: {output_file}")
    print(f"  Genotyped: {len(genotyped_variants):,}")
    print(f"  Imputed: {len(filtered_imputed_variants):,}")
    print(f"  Total: {len(all_variants):,}")

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python3 merge_variants.py <json_file> <imputed_parquet> <output_parquet>")
        print("Example: python3 merge_variants.py server-data/variants/1769791316003_Ethan.json server-data/imputed/1769791316003_Ethan_imputed.parquet server-data/unified/1769791316003_Ethan.parquet")
        sys.exit(1)
    
    merge_variants(sys.argv[1], sys.argv[2], sys.argv[3])
