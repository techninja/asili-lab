#!/usr/bin/env python3
"""
Phase 2: User Imputation Pipeline
Converts user DNA → BCF → Beagle imputation → filtered Parquet
"""
import sys
import subprocess
import json
from pathlib import Path
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

BEAGLE_JAR = os.getenv('BEAGLE_DIR', './tools/beagle') + '/beagle.jar'
REF_PANEL_DIR = os.getenv('REF_PANEL_DIR', './cache/1000g_reference')
REF_PANEL_TYPE = os.getenv('REF_PANEL_TYPE', 'auto')  # 'auto', '1000g', or 'topmed'
TARGET_LIST = './data_out/pgs_positions.txt'
OUTPUT_DIR = './server-data/imputed'
TEMP_DIR = os.getenv('LARGE_TMP', '/tmp') + '/asili_imputation'

def convert_to_vcf(user_file, user_id, build='hg38'):
    """Convert 23andMe JSON file to VCF.gz."""
    print(f"Converting {user_file} to VCF...")
    
    Path(TEMP_DIR).mkdir(parents=True, exist_ok=True)
    
    # Load JSON format from server-data/variants
    with open(user_file) as f:
        data = json.load(f)
    
    variants = data['variants']
    
    output_vcf = f"{TEMP_DIR}/{user_id}_raw.vcf"
    output_vcf_gz = f"{TEMP_DIR}/{user_id}_raw.vcf.gz"
    
    # Create VCF
    with open(output_vcf, 'w') as out:
        # Write VCF header with proper FORMAT definition
        out.write("##fileformat=VCFv4.2\n")
        out.write(f"##reference={build}\n")
        out.write("##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">\n")
        out.write(f"#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t{user_id}\n")
        
        for variant in variants:
            chrom = variant.get('chromosome', '')
            pos = variant.get('position', 0)
            rsid = variant.get('rsid', '.')
            allele1 = variant.get('allele1', '')
            allele2 = variant.get('allele2', '')
            
            # Skip non-standard chromosomes
            if chrom not in [str(i) for i in range(1, 23)] + ['X', 'Y', 'MT']:
                continue
            
            # Skip missing or invalid genotypes (only allow A, C, G, T)
            valid_alleles = {'A', 'C', 'G', 'T'}
            if (not allele1 or not allele2 or 
                allele1 not in valid_alleles or allele2 not in valid_alleles):
                continue
            
            # For homozygous, pick arbitrary REF/ALT and set GT accordingly
            if allele1 == allele2:
                ref = allele1
                # Pick different ALT (doesn't matter which for homozygous)
                alt = 'C' if ref != 'C' else 'T'
                gt = "0/0"  # Homozygous reference
            else:
                ref, alt = sorted([allele1, allele2])  # Consistent ordering
                gt = "0/1"  # Heterozygous
            
            out.write(f"{chrom}\t{pos}\t{rsid}\t{ref}\t{alt}\t.\tPASS\t.\tGT\t{gt}\n")
    
    # Compress and index VCF
    subprocess.run(['bgzip', '-c', output_vcf], stdout=open(output_vcf_gz, 'wb'), check=True)
    subprocess.run(['tabix', '-p', 'vcf', output_vcf_gz], check=True)
    
    os.remove(output_vcf)
    
    print(f"✓ VCF created: {output_vcf_gz}")
    return output_vcf_gz

def detect_panel_type():
    """Auto-detect reference panel type."""
    if REF_PANEL_TYPE != 'auto':
        return REF_PANEL_TYPE
    
    # Check for TOPMed files first (higher priority)
    if Path(f"{REF_PANEL_DIR}/chr1.topmed.vcf.gz").exists():
        return 'topmed'
    elif Path(f"{REF_PANEL_DIR}/chr1.1kg.phase3.v5a.vcf.gz").exists():
        return '1000g'
    else:
        raise FileNotFoundError(f"No reference panel found in {REF_PANEL_DIR}")

def run_beagle_imputation(user_vcf, user_id, chromosome):
    """Run Beagle imputation for one chromosome."""
    panel_type = detect_panel_type()
    print(f"  Imputing chr{chromosome} using {panel_type.upper()} panel...")
    
    # Extract chromosome-specific variants from user VCF
    chr_vcf = f"{TEMP_DIR}/{user_id}_chr{chromosome}.vcf.gz"
    subprocess.run([
        'bcftools', 'view',
        '-r', str(chromosome),
        '-O', 'z',
        '-o', chr_vcf,
        user_vcf
    ], check=True)
    subprocess.run(['tabix', '-p', 'vcf', chr_vcf], check=True)
    
    # Select reference panel file based on type
    if panel_type == 'topmed':
        ref_panel = f"{REF_PANEL_DIR}/chr{chromosome}.topmed.vcf.gz"
        # TOPMed uses "chr1" format, need to rename chromosomes in user VCF
        chr_vcf_renamed = f"{TEMP_DIR}/{user_id}_chr{chromosome}_renamed.vcf.gz"
        subprocess.run([
            'bcftools', 'annotate',
            '--rename-chrs', '/dev/stdin',
            '-O', 'z',
            '-o', chr_vcf_renamed,
            chr_vcf
        ], input=f"{chromosome}\tchr{chromosome}\n".encode(), check=True)
        subprocess.run(['tabix', '-p', 'vcf', chr_vcf_renamed], check=True)
        os.remove(chr_vcf)
        os.remove(chr_vcf + '.tbi')
        chr_vcf = chr_vcf_renamed
    else:
        ref_panel = f"{REF_PANEL_DIR}/chr{chromosome}.1kg.phase3.v5a.vcf.gz"
    
    if not Path(ref_panel).exists():
        raise FileNotFoundError(f"Reference panel not found: {ref_panel}")
    
    output_prefix = f"{TEMP_DIR}/{user_id}_chr{chromosome}_imputed"
    
    cmd = [
        'java', '-Xmx8g', '-jar', BEAGLE_JAR,
        f'gt={chr_vcf}',
        f'ref={ref_panel}',
        f'out={output_prefix}',
        'impute=true',
        'gp=true',
        'nthreads=8'
    ]
    
    subprocess.run(cmd, check=True)
    
    # Cleanup chromosome-specific input
    os.remove(chr_vcf)
    os.remove(chr_vcf + '.tbi')
    
    return f"{output_prefix}.vcf.gz"

def convert_to_bcf(imputed_vcf, user_id, chromosome):
    """Convert imputed VCF to BCF (no filtering - keep all variants)."""
    # Index the imputed VCF
    subprocess.run(['tabix', '-p', 'vcf', imputed_vcf], check=True, capture_output=True)
    
    # Convert to BCF without filtering
    output_bcf = f"{TEMP_DIR}/{user_id}_chr{chromosome}.bcf"
    
    subprocess.run([
        'bcftools', 'view',
        '--threads', '2',
        '-O', 'b',
        '-o', output_bcf,
        imputed_vcf
    ], check=True, capture_output=True)
    
    os.remove(imputed_vcf)
    os.remove(imputed_vcf + '.tbi')
    
    return output_bcf

def bcf_to_parquet(bcf_files, user_id):
    """Convert filtered BCF files to Parquet for scoring."""
    print(f"Converting to Parquet...")
    
    import pyarrow as pa
    import pyarrow.parquet as pq
    
    variants = []
    dosages = []
    
    for bcf in bcf_files:
        # Index BCF for querying
        subprocess.run(['bcftools', 'index', '-f', bcf], check=True)
        
        result = subprocess.run(
            ['bcftools', 'query', '-f', '%CHROM:%POS:%REF:%ALT\t[%DS]\n', bcf],
            capture_output=True, text=True, check=True
        )
        
        for line in result.stdout.strip().split('\n'):
            if not line:
                continue
            parts = line.split('\t')
            if len(parts) != 2:
                continue
            variant_id, dosage_str = parts
            
            # Normalize chromosome names: chr1 -> 1
            if variant_id.startswith('chr'):
                variant_id = variant_id[3:]  # Remove "chr" prefix
            
            # Handle multi-allelic sites (DS can be comma-separated)
            # Sum all ALT allele dosages for total non-REF dosage
            if ',' in dosage_str:
                dosage = sum(float(d) for d in dosage_str.split(','))
            else:
                dosage = float(dosage_str)
            
            variants.append(variant_id)
            dosages.append(dosage)
    
    table = pa.table({
        'variant_id': pa.array(variants),
        'genotype_dosage': pa.array(dosages, type=pa.float32())
    })
    
    output_parquet = f"{OUTPUT_DIR}/{user_id}_imputed.parquet"
    pq.write_table(table, output_parquet, compression='zstd')
    
    print(f"✓ {len(variants):,} imputed variants saved to {output_parquet}")
    return output_parquet, variants, dosages

def merge_with_genotyped(user_file, imputed_variants, imputed_dosages, user_id):
    """Merge genotyped variants with imputed variants into unified file."""
    print(f"\nMerging with genotyped variants...")
    
    import pyarrow as pa
    import pyarrow.parquet as pq
    
    with open(user_file) as f:
        data = json.load(f)
    
    genotyped_variants = []
    genotyped_dosages = []
    genotyped_positions = set()
    
    for variant in data['variants']:
        chrom = variant.get('chromosome', '')
        pos = variant.get('position', 0)
        allele1 = variant.get('allele1', '')
        allele2 = variant.get('allele2', '')
        
        if chrom not in [str(i) for i in range(1, 23)] + ['X', 'Y', 'MT']:
            continue
        if allele1 not in {'A', 'C', 'G', 'T'} or allele2 not in {'A', 'C', 'G', 'T'}:
            continue
        
        ref, alt = sorted([allele1, allele2])
        variant_id = f"{chrom}:{pos}:{ref}:{alt}"
        
        if allele1 == allele2:
            dosage = 0.0 if allele1 == ref else 2.0
        else:
            dosage = 1.0
        
        genotyped_variants.append(variant_id)
        genotyped_dosages.append(dosage)
        genotyped_positions.add(f"{chrom}:{pos}")
    
    print(f"  ✓ Loaded {len(genotyped_variants):,} genotyped variants")
    
    filtered_imputed_variants = []
    filtered_imputed_dosages = []
    
    for vid, dosage in zip(imputed_variants, imputed_dosages):
        parts = vid.split(':')
        if len(parts) >= 2:
            pos_key = f"{parts[0]}:{parts[1]}"
            if pos_key not in genotyped_positions:
                filtered_imputed_variants.append(vid)
                filtered_imputed_dosages.append(dosage)
    
    print(f"  ✓ Filtered to {len(filtered_imputed_variants):,} unique imputed positions")
    
    all_variants = genotyped_variants + filtered_imputed_variants
    all_dosages = genotyped_dosages + filtered_imputed_dosages
    
    print(f"  ✓ Creating unified file with {len(all_variants):,} total variants...")
    
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
        'imputed': pa.array([False] * len(genotyped_variants) + [True] * len(filtered_imputed_variants), type=pa.bool_()),
        'chr': pa.array(all_chr, type=pa.int8()),
        'pos': pa.array(all_pos, type=pa.int32())
    })
    
    unified_dir = f"{OUTPUT_DIR}/../unified"
    Path(unified_dir).mkdir(parents=True, exist_ok=True)
    unified_file = f"{unified_dir}/{user_id}.parquet"
    pq.write_table(table, unified_file, compression='zstd')
    
    print(f"✓ Unified file created: {unified_file}")
    print(f"  Genotyped: {len(genotyped_variants):,}")
    print(f"  Imputed: {len(filtered_imputed_variants):,}")
    print(f"  Total: {len(all_variants):,}")
    
    return unified_file

def main(user_file, user_id_with_name):
    """Run full imputation pipeline."""
    Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
    
    # Extract just the numeric ID for VCF sample name (Beagle requirement)
    user_id_numeric = user_id_with_name.split('_')[0]
    
    panel_type = detect_panel_type()
    print(f"\\n🧬 Imputation Pipeline for {user_id_with_name}")
    print(f"📊 Reference Panel: {panel_type.upper()}")
    print(f"📁 Panel Directory: {REF_PANEL_DIR}\\n")
    
    # Step 1: Convert to VCF.gz (use numeric ID for VCF sample column)
    user_vcf = convert_to_vcf(user_file, user_id_numeric)
    
    # Step 2: Impute per chromosome (sequential - Beagle uses 8 threads)
    print(f"\\nRunning Beagle imputation (this will take 1-2 hours)...")
    imputed_vcfs = []
    
    for chrom in range(1, 23):
        imputed_vcf = run_beagle_imputation(user_vcf, user_id_numeric, chrom)
        imputed_vcfs.append((chrom, imputed_vcf))
    
    # Step 3: Convert to BCF in parallel (no filtering - keep all variants)
    print(f"\\nConverting to BCF (parallel)...")
    bcf_files = [None] * 22
    
    # Use more workers since conversion is I/O bound
    with ThreadPoolExecutor(max_workers=16) as executor:
        futures = {}
        for chrom, imputed_vcf in imputed_vcfs:
            future = executor.submit(convert_to_bcf, imputed_vcf, user_id_numeric, chrom)
            futures[future] = chrom
        
        for future in as_completed(futures):
            chrom = futures[future]
            bcf_file = future.result()
            bcf_files[chrom - 1] = bcf_file
            print(f"  ✓ chr{chrom} converted")
    
    # Step 4: Convert to Parquet (use full ID with name for output filename)
    print(f"\\nFinalizing...")
    parquet_file, imputed_variants, imputed_dosages = bcf_to_parquet(bcf_files, user_id_with_name)
    
    # Step 5: Merge with genotyped to create unified file
    unified_file = merge_with_genotyped(user_file, imputed_variants, imputed_dosages, user_id_with_name)
    
    # Cleanup
    for bcf in bcf_files:
        os.remove(bcf)
    os.remove(user_vcf)
    os.remove(user_vcf + '.tbi')
    
    print(f"\\n✅ Imputation complete!")
    print(f"  Imputed file: {parquet_file}")
    print(f"  Unified file: {unified_file}\\n")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python3 impute_user.py <user_dna_file> <user_id_with_name>")
        print("Example: python3 impute_user.py ./server-data/variants/1769791316003_Ethan.json 1769791316003_Ethan")
        sys.exit(1)
    
    main(sys.argv[1], sys.argv[2])
