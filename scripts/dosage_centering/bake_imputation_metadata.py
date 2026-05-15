#!/usr/bin/env python3
"""
Bake imputation metadata (DR2 + expected_dosage) into .asili exports.

Reads unified parquet chr-by-chr, looks up DR2 and AF from per-chr parquet dicts,
writes new per-chr files with imputation_quality and expected_dosage columns.

expected_dosage = 2 * AF (ALT allele frequency from TOPMed).
At score time, this is subtracted from oriented dosage for imputed variants only,
eliminating population-frequency bias.

Usage:
  .venv/bin/python3 scripts/dosage_centering/bake_imputation_metadata.py [name_filter]
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
AF_DIR = f'{_REPO}/data_out/af_lookup'

CHR_NAMES = {23: 'X', 24: 'Y', 25: 'MT'}


def load_dr2_dict(chr_num):
    """Load per-chr DR2 parquet into {allele_key: dr2} dict."""
    path = f'{DR2_DIR}/dr2_lookup_chr{chr_num}.parquet'
    if not Path(path).exists():
        return {}
    t = pq.read_table(path, columns=['allele_key', 'dr2'])
    return dict(zip(t.column('allele_key').to_pylist(), t.column('dr2').to_pylist()))


def load_af_dict(chr_num):
    """Load per-chr AF parquet into {(pos, allele_key): af} dict."""
    path = f'{AF_DIR}/af_lookup_chr{chr_num}.parquet'
    if not Path(path).exists():
        return {}
    t = pq.read_table(path, columns=['pos', 'allele_key', 'af'])
    positions = t.column('pos').to_pylist()
    keys = t.column('allele_key').to_pylist()
    afs = t.column('af').to_pylist()
    return {(p, k): a for p, k, a in zip(positions, keys, afs)}


def process_individual(parquet_file):
    """Read unified parquet, add dr2 + expected_dosage columns, write .asili archive."""
    input_path = f'{UNIFIED_DIR}/{parquet_file}'
    name = Path(parquet_file).stem.split('_', 1)[1] if '_' in Path(parquet_file).stem else Path(parquet_file).stem
    output_path = f'{EXPORT_DIR}/{name}_imputed.asili'

    print(f'\n🧬 Baking DR2 + AF into {name}...')

    # Get unique chromosomes
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

        filters = [('chr', '=', chr_num)]
        chr_table = pq.read_table(input_path, filters=filters)

        allele_keys = chr_table.column('allele_key').to_pylist()
        imputed = chr_table.column('imputed').to_pylist()

        # Load lookups (autosomes only)
        dr2_dict = load_dr2_dict(chr_num) if chr_num <= 22 else {}
        af_dict = load_af_dict(chr_num) if chr_num <= 22 else {}

        dr2_values = []
        expected_dosage_values = []
        af_found = 0

        positions = chr_table.column('pos').to_pylist()

        for pos, ak, imp in zip(positions, allele_keys, imputed):
            if imp:
                dr2_values.append(dr2_dict.get(ak, 0.5))
                af = af_dict.get((pos, ak))
                if af is not None:
                    expected_dosage_values.append(2.0 * af)
                    af_found += 1
                else:
                    # Fallback: 2*0.5 = 1.0 (uninformative center)
                    expected_dosage_values.append(1.0)
            else:
                dr2_values.append(1.0)
                expected_dosage_values.append(0.0)  # Not used for genotyped (SQL guards)

        # Set imputation_quality
        col_idx = chr_table.schema.get_field_index('imputation_quality')
        chr_table = chr_table.set_column(col_idx, 'imputation_quality', pa.array(dr2_values, type=pa.float32()))

        # Add expected_dosage column
        chr_table = chr_table.append_column('expected_dosage', pa.array(expected_dosage_values, type=pa.float32()))
        chr_table = chr_table.sort_by([('pos', 'ascending'), ('allele_key', 'ascending')])

        out_file = f'chr{label}.parquet'
        pq.write_table(chr_table, f'{tmp_dir}/{out_file}', compression='zstd')

        n = len(chr_table)
        imputed_count = sum(1 for x in imputed if x)
        af_pct = (af_found / imputed_count * 100) if imputed_count else 0
        manifest_chrs[label] = {
            'file': out_file,
            'variants': n,
            'imputed_count': imputed_count,
            'genotyped_count': n - imputed_count,
        }
        total_variants += n
        print(f'{n:,} variants (DR2 avg={sum(dr2_values)/len(dr2_values):.3f}, AF coverage={af_pct:.1f}%)')

        del chr_table, dr2_dict, af_dict, allele_keys, imputed, dr2_values, expected_dosage_values

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
        'dosage_centering': 'TOPMed ALT AF, expected_dosage = 2*AF',
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

    print(f'📊 Baking imputation metadata into .asili exports')
    print(f'   DR2 source: {DR2_DIR}')
    print(f'   AF source:  {AF_DIR}')
    print(f'   Individuals: {len(parquet_files)}')

    for pf in sorted(parquet_files):
        process_individual(pf)

    print('\n✓ All exports complete')


if __name__ == '__main__':
    main()
