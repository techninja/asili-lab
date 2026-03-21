#!/usr/bin/env python3
"""
Extract unique chr:pos from all PGS trait files without loading into memory.
Streams through parquet files in parallel.
"""
import sys
import pyarrow.parquet as pq
from pathlib import Path
from collections import defaultdict
from multiprocessing import Pool, cpu_count

def extract_positions_from_file(parquet_path):
    """Stream through one parquet file and return chr:pos pairs."""
    positions = []
    try:
        table = pq.read_table(str(parquet_path), columns=['variant_id'])
        
        for batch in table.to_batches(max_chunksize=10000):
            for variant_id in batch['variant_id']:
                if variant_id is None:
                    continue
                variant_str = variant_id.as_py()
                if not variant_str or ':' not in variant_str:
                    continue
                
                parts = variant_str.split(':')
                if len(parts) >= 2:
                    try:
                        chr_name = parts[0]
                        pos = int(parts[1])
                        positions.append(f"{chr_name}:{pos}")
                    except:
                        continue
    except Exception as e:
        print(f"    Error processing {parquet_path.name}: {e}")
    
    return (parquet_path.name, positions)

def main(packs_dir, output_file, n_cores=None):
    """Extract all unique positions across all trait files in parallel."""
    if n_cores is None:
        n_cores = max(1, cpu_count() - 2)  # Leave 2 cores free
    
    packs_path = Path(packs_dir)
    parquet_files = list(packs_path.glob('*_hg38.parquet'))
    
    print(f"Found {len(parquet_files)} trait files")
    print(f"Processing with {n_cores} cores...\n")
    
    # Process files in parallel, write results incrementally
    temp_file = output_file + '.tmp'
    
    with open(temp_file, 'w') as f:
        with Pool(n_cores) as pool:
            for i, (filename, positions) in enumerate(pool.imap_unordered(extract_positions_from_file, parquet_files), 1):
                print(f"  [{i}/{len(parquet_files)}] {filename}: {len(positions):,} variants")
                # Write immediately, don't accumulate in memory
                for pos in positions:
                    f.write(f"{pos}\n")
    
    # Deduplicate and sort
    print(f"\nDeduplicating and sorting...")
    import subprocess
    subprocess.run(f"sort -u {temp_file} > {output_file}", shell=True, check=True)
    subprocess.run(f"rm {temp_file}", shell=True)
    
    # Count results
    result = subprocess.run(f"wc -l {output_file}", shell=True, capture_output=True, text=True)
    total = int(result.stdout.split()[0])
    
    print(f"✓ {total:,} unique positions")
    
    # Count per chromosome
    print("\nPositions per chromosome:")
    result = subprocess.run(f"cut -d: -f1 {output_file} | uniq -c", shell=True, capture_output=True, text=True)
    for line in result.stdout.strip().split('\n'):
        if line.strip():
            count, chr_name = line.strip().split()
            print(f"  chr{chr_name}: {int(count):,}")

if __name__ == '__main__':
    packs_dir = sys.argv[1] if len(sys.argv) > 1 else 'data_out/packs'
    output_file = sys.argv[2] if len(sys.argv) > 2 else 'data_out/pgs_positions.txt'
    n_cores = int(sys.argv[3]) if len(sys.argv) > 3 else None
    main(packs_dir, output_file, n_cores)
