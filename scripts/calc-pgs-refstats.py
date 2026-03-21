#!/usr/bin/env python3
import duckdb
import sys
import os
import json
import time
from pathlib import Path

def process_all_pgs(gnomad_parquet, parquet_dir, output_file, pgs_list_file, packs_file):
    print("Initializing DuckDB...")
    conn = duckdb.connect(':memory:')
    conn.execute("SET memory_limit='32GB'")
    conn.execute("SET threads TO 8")
    
    # Load PGS list from JSON file
    print(f"Loading PGS list: {pgs_list_file}")
    with open(pgs_list_file, 'r') as f:
        pgs_to_process = set(json.load(f))
    
    print(f"Found {len(pgs_to_process)} PGS to process")
    
    # Load packs list from JSON file
    print(f"Loading packs list: {packs_file}")
    with open(packs_file, 'r') as f:
        packs_needed = set(json.load(f))
    
    print(f"Found {len(packs_needed)} packs to process")
    
    if len(pgs_to_process) == 0:
        print("No PGS to process.")
        return
    
    print(f"Loading gnomAD parquet: {gnomad_parquet}")
    start = time.time()
    conn.execute(f"CREATE VIEW gnomad AS SELECT * FROM read_parquet('{gnomad_parquet}')")
    print(f"Loaded in {time.time() - start:.1f}s")
    
    # Filter parquet files to only needed packs
    all_files = sorted(Path(parquet_dir).glob('*.parquet'))
    parquet_files = [pf for pf in all_files if pf.stem.replace('_hg38', '') in packs_needed]
    
    print(f"Processing {len(parquet_files)}/{len(all_files)} packs\n")
    
    results = {}
    total_variants = 0
    total_found = 0
    overall_start = time.time()
    
    for i, pf in enumerate(parquet_files, 1):
        trait_id = pf.stem.replace('_hg38', '')
        start = time.time()
        
        query_result = conn.execute(f"""
            WITH parsed AS (
                SELECT 
                    'chr' || split_part(variant_id, ':', 1) as chr,
                    TRY_CAST(split_part(variant_id, ':', 2) AS INTEGER) as pos,
                    split_part(variant_id, ':', 3) as ref,
                    split_part(variant_id, ':', 4) as alt,
                    effect_weight,
                    pgs_id
                FROM read_parquet('{pf}')
                WHERE split_part(variant_id, ':', 2) != ''
            )
            SELECT 
                p.pgs_id,
                COUNT(*) as total_variants,
                COUNT(g.af) as found_in_gnomad,
                SUM(CASE WHEN g.af IS NOT NULL THEN p.effect_weight * 2 * g.af ELSE 0 END) as mean_score,
                SQRT(SUM(CASE WHEN g.af IS NOT NULL THEN p.effect_weight * p.effect_weight * 2 * g.af * (1 - g.af) ELSE 0 END)) as stddev_score
            FROM parsed p
            LEFT JOIN gnomad g 
              ON p.chr = g.chr AND p.pos = g.pos AND p.ref = g.ref AND p.alt = g.alt
            WHERE p.pgs_id IN ({','.join(f"'{x}'" for x in pgs_to_process)})
            GROUP BY p.pgs_id
        """).fetchall()
        
        elapsed = time.time() - start
        
        for row in query_result:
            pgs_id, total, found, mean_score, stddev_score = row
            
            results[pgs_id] = {
                'trait_id': trait_id,
                'total_variants': total,
                'found_in_gnomad': found,
                'coverage_pct': round(found / total * 100, 2) if total > 0 else 0,
                'mean_score': float(mean_score) if mean_score else None,
                'stddev_score': float(stddev_score) if stddev_score else None
            }
            total_variants += total
            total_found += found
            rate = total / elapsed if elapsed > 0 else 0
            print(f"[{i}/{len(parquet_files)}] {pgs_id}: {found}/{total} ({found/total*100:.1f}%) - {rate:.0f} var/sec")
    
    conn.close()
    
    with open(output_file, 'w') as f:
        json.dump(results, f, indent=2)
    
    total_elapsed = time.time() - overall_start
    overall_rate = total_variants / total_elapsed if total_elapsed > 0 else 0
    
    print(f"\n{'='*60}")
    print(f"Total PGS: {len(results)}")
    print(f"Total variants: {total_variants:,}")
    print(f"Found in gnomAD: {total_found:,} ({total_found/total_variants*100:.1f}%)")
    print(f"Time: {total_elapsed/60:.1f} min")
    print(f"Rate: {overall_rate:,.0f} variants/sec")
    print(f"Output: {output_file}")

if __name__ == '__main__':
    gnomad_parquet = sys.argv[1]
    parquet_dir = sys.argv[2]
    output_file = sys.argv[3]
    pgs_list_file = sys.argv[4]
    packs_file = sys.argv[5]
    process_all_pgs(gnomad_parquet, parquet_dir, output_file, pgs_list_file, packs_file)
