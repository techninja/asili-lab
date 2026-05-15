#!/usr/bin/env python3
"""
Split TOPMed allele_frequencies.tsv into per-chromosome parquets keyed by allele_key.

Input:  allele_frequencies.tsv (chr-prefixed variant_id\tAF, no header, ~70M rows)
Output: data_out/af_lookup/af_lookup_chr{1-22}.parquet (allele_key INT64, af FLOAT)

The allele_key is computed identically to the DuckDB SQL expression:
  md5(LEAST(alleleA, alleleB) || ':' || GREATEST(alleleA, alleleB))[:15] as BIGINT

Usage:
  .venv/bin/python3 scripts/dosage_centering/split_af.py
"""
import hashlib
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

_REPO = Path(__file__).resolve().parent.parent.parent
AF_FILE = '/media/techninja/gnomad/asili_cache/topmed_reference/allele_frequencies.tsv'
OUT_DIR = _REPO / 'data_out' / 'af_lookup'


def compute_allele_key(allele_a, allele_b):
    """Match the DuckDB allele_key expression exactly."""
    lo, hi = (allele_a, allele_b) if allele_a < allele_b else (allele_b, allele_a)
    digest = hashlib.md5(f'{lo}:{hi}'.encode()).hexdigest()[:15]
    return int(digest, 16)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Accumulate per-chromosome: keyed by (pos, allele_key) to avoid collisions
    chr_data = {str(c): ([], [], []) for c in range(1, 23)}  # pos, allele_key, af

    print(f'📖 Reading {AF_FILE}...')
    with open(AF_FILE) as f:
        for i, line in enumerate(f):
            if i % 10_000_000 == 0 and i > 0:
                print(f'  {i:,} lines...', flush=True)
            parts = line.rstrip('\n').split('\t')
            if len(parts) != 2:
                continue
            variant_id, af_str = parts
            # variant_id format: chr1:10390:CCCCTAA:C (chr-prefixed)
            fields = variant_id.split(':')
            if len(fields) != 4:
                continue
            chr_str = fields[0].replace('chr', '')
            if chr_str not in chr_data:
                continue
            pos = int(fields[1])
            allele_a, allele_b = fields[2], fields[3]
            ak = compute_allele_key(allele_a, allele_b)
            af = float(af_str)
            positions, keys, afs = chr_data[chr_str]
            positions.append(pos)
            keys.append(ak)
            afs.append(af)

    print(f'\n💾 Writing per-chromosome parquets...')
    for chr_num in range(1, 23):
        positions, keys, afs = chr_data[str(chr_num)]
        if not keys:
            continue
        table = pa.table({
            'pos': pa.array(positions, type=pa.int32()),
            'allele_key': pa.array(keys, type=pa.int64()),
            'af': pa.array(afs, type=pa.float32()),
        })
        out_path = OUT_DIR / f'af_lookup_chr{chr_num}.parquet'
        pq.write_table(table, out_path, compression='zstd')
        print(f'  chr{chr_num}: {len(keys):,} variants')

    total = sum(len(chr_data[str(c)][1]) for c in range(1, 23))
    print(f'\n✅ Done — {total:,} variants across 22 chromosomes')


if __name__ == '__main__':
    main()
