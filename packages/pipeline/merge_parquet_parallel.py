#!/usr/bin/env python3
import pyarrow.parquet as pq
import pyarrow as pa
import sys
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

def merge_parallel(input_files, output_file, max_workers=8):
    """Parallel merge using multiple threads for I/O"""
    
    valid_files = [f for f in input_files if os.path.exists(f) and os.path.getsize(f) > 0]
    
    if not valid_files:
        print("Error: No valid files to merge")
        sys.exit(1)
    
    print(f"Parallel merge of {len(valid_files)} files (workers: {max_workers})...")
    
    # Read all files in parallel
    def read_file(file_path):
        return pq.read_table(file_path)
    
    tables = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(read_file, f): f for f in valid_files}
        for future in as_completed(futures):
            file_path = futures[future]
            try:
                table = future.result()
                tables.append(table)
                print(f"  ✓ Read {Path(file_path).name}")
            except Exception as e:
                print(f"  ✗ Failed {Path(file_path).name}: {e}")
    
    # Concatenate and write
    print(f"Concatenating {len(tables)} tables...")
    combined = pa.concat_tables(tables)
    
    print(f"Writing output ({len(combined):,} rows)...")
    pq.write_table(combined, output_file, compression='zstd', compression_level=3)
    
    size_mb = os.path.getsize(output_file) / (1024 * 1024)
    print(f"✓ Merged into {output_file} ({size_mb:.1f}MB)")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 merge_parquet_parallel.py <input1> <input2> ... <output>")
        sys.exit(1)
    
    input_files = sys.argv[1:-1]
    output_file = sys.argv[-1]
    
    # Use more workers for native execution
    workers = min(len(input_files), os.cpu_count() or 8)
    merge_parallel(input_files, output_file, max_workers=workers)
