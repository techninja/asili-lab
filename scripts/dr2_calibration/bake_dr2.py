#!/usr/bin/env python3
"""
Bake DR2 into .asili exports by reading unified parquet chr-by-chr,
looking up DR2 from per-chr parquet dicts, and writing new per-chr files.

No DuckDB JOINs. Pure Python + PyArrow streaming. ~300MB peak memory.

Usage:
  .venv/bin/python3 scripts/dr2_calibration/bake_dr2.py [name_filter]
"""
import sys
import os
import json
import tarfile
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

_REPO = str(Path(__file__).resolve().parent.parent.parent)

# Load .env
import re
_env_file = Path(_REPO) / '.env'
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        m = re.match(r'^([^=#]+)=(.*)$', line)
        if m and m.group(1).strip() not in os.environ:
            os.environ[m.group(1).strip()] = m.group(2).strip()

UNIFIED_DIR = f'{_REPO}/server-data/unified'
EXPORT_DIR = f'{_REPO}/server-data/export'
DR2_DIR = f'{_REPO}/data_out/dr2_lookup'

CHR_NAMES = {23: 'X', 24: 'Y', 25: 'MT'}


def load_dr2_dict(chr_num):
    """Load per-chr DR2 parquet into {allele_key: dr2} dict."""
    path = f'{DR2_DIR}/dr2_lookup_chr{chr_num}.parquet'
    if not Path(path).exists():
        return {}
    t = pq.read_table(path, columns=['allele_key', 'dr2'])
    return dict(zip(t.column('allele_key').to_pylist(), t.column('dr2').to_pylist()))


def process_individual(parquet_file):
    """Read unified parquet, add dr2 column per-chr, write .asili archive."""
    input_path = f'{UNIFIED_DIR}/{parquet_file}'
    name = Path(parquet_file).stem.split('_', 1)[1] if '_' in Path(parquet_file).stem else Path(parquet_file).stem
    output_path = f'{EXPORT_DIR}/{name}_imputed.asili'

    print(f'\n🧬 Baking DR2 into {name}...')

    # Read and process one chromosome at a time using row-group filtering
    pf = pq.ParquetFile(input_path)
    metadata = pf.schema_arrow

    # First pass: get unique chr values
    chr_table = pq.read_table(input_path, columns=['chr'])
    chromosomes = sorted(set(v for v in chr_table.column('chr').to_pylist() if v and v <= 25))
    del chr_table

    tmp_dir = f'{EXPORT_DIR}/.tmp_{name}'
    Path(tmp_dir).mkdir(parents=True, exist_ok=True)

    manifest_chrs = {}
    total_variants = 0

    for chr_num in chromosomes:
        label = CHR_NAMES.get(chr_num, str(chr_num))
        print(f'  chr{label}...', end=' ', flush=True)

        # Read only this chromosome's rows
        filters = [('chr', '=', chr_num)]
        chr_table = pq.read_table(input_path, filters=filters)

        # Load DR2 dict for this chromosome
        dr2_dict = load_dr2_dict(chr_num) if chr_num <= 22 else {}

        # Look up DR2 for each variant
        allele_keys = chr_table.column('allele_key').to_pylist()
        imputed = chr_table.column('imputed').to_pylist()
        dr2_values = []
        for ak, imp in zip(allele_keys, imputed):
            if imp:
                dr2_values.append(dr2_dict.get(ak, 0.5))
            else:
                dr2_values.append(1.0)

        # Overwrite imputation_quality with DR2 values, drop separate dr2 column
        col_idx = chr_table.schema.get_field_index('imputation_quality')
        chr_table = chr_table.set_column(col_idx, 'imputation_quality', pa.array(dr2_values, type=pa.float32()))
        chr_table = chr_table.sort_by([('pos', 'ascending'), ('allele_key', 'ascending')])

        out_file = f'chr{label}.parquet'
        pq.write_table(chr_table, f'{tmp_dir}/{out_file}', compression='zstd')

        n = len(chr_table)
        imputed_count = sum(1 for x in imputed if x)
        manifest_chrs[label] = {
            'file': out_file,
            'variants': n,
            'imputed_count': imputed_count,
            'genotyped_count': n - imputed_count,
        }
        total_variants += n
        print(f'{n:,} variants (avg DR2={sum(dr2_values)/len(dr2_values):.3f})')

        del chr_table, dr2_dict, allele_keys, imputed, dr2_values

    # Write manifest
    total_imputed = sum(c['imputed_count'] for c in manifest_chrs.values())
    total_genotyped = sum(c['genotyped_count'] for c in manifest_chrs.values())
    manifest = {
        'format': 'asili-unified-v1',
        'totalVariants': total_variants,
        'imputedVariants': total_imputed,
        'genotypedVariants': total_genotyped,
        'chromosomes': manifest_chrs,
        'createdAt': __import__('datetime').datetime.now().isoformat(),
        'individual': name,
        'source': 'AncestryDNA + TOPMed imputation',
        'dr2_calibration': 'NYGC 3202 samples vs TOPMed',
    }
    with open(f'{tmp_dir}/manifest.json', 'w') as f:
        json.dump(manifest, f, indent=2)

    # Build tar
    Path(EXPORT_DIR).mkdir(parents=True, exist_ok=True)
    with tarfile.open(output_path, 'w') as tar:
        tar.add(f'{tmp_dir}/manifest.json', arcname='manifest.json')
        for chr_meta in manifest_chrs.values():
            tar.add(f'{tmp_dir}/{chr_meta["file"]}', arcname=chr_meta['file'])

    # Cleanup
    import shutil
    shutil.rmtree(tmp_dir)

    size_mb = os.path.getsize(output_path) / 1e6
    print(f'  ✅ {name}_imputed.asili ({size_mb:.0f} MB — {total_variants:,} variants)')


def main():
    name_filter = sys.argv[1] if len(sys.argv) > 1 else None

    parquet_files = [f for f in os.listdir(UNIFIED_DIR) if f.endswith('.parquet')]
    if name_filter:
        parquet_files = [f for f in parquet_files if name_filter.lower() in f.lower()]

    if not parquet_files:
        print('❌ No unified parquet files found')
        return

    print(f'📊 Baking DR2 into .asili exports')
    print(f'   DR2 source: {DR2_DIR}')
    print(f'   Individuals: {len(parquet_files)}')

    for pf in sorted(parquet_files):
        process_individual(pf)

    print('\n✓ All exports complete')


if __name__ == '__main__':
    main()
