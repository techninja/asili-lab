#!/usr/bin/env python3
"""
DR2 Calibration Pipeline
Computes per-variant imputation quality (DR2) by masking NYGC 30x samples
to consumer array positions, imputing against TOPMed, and comparing to truth.

Usage:
  pnpm dr2                        # all 3202 samples, all chroms, resumable
  pnpm dr2 -- --chroms 22         # single chromosome
  pnpm dr2 -- --test              # 3 samples, chr22 only
"""
import sys
import os
import json
import subprocess
import argparse
import time
from pathlib import Path

_REPO = str(Path(__file__).resolve().parent.parent.parent)

# Load .env
_env_file = Path(_REPO) / '.env'
if _env_file.exists():
    import re
    for line in _env_file.read_text().splitlines():
        m = re.match(r'^([^=#]+)=(.*)$', line)
        if m and m.group(1).strip() not in os.environ:
            os.environ[m.group(1).strip()] = m.group(2).strip()

BEAGLE_JAR = os.getenv('BEAGLE_DIR', f'{_REPO}/tools/beagle') + '/beagle.jar'
EAGLE_BIN = os.getenv('EAGLE_DIR', f'{_REPO}/tools/eagle') + '/eagle'
GENETIC_MAP = os.getenv('EAGLE_DIR', f'{_REPO}/tools/eagle') + '/genetic_map_hg38_withX.txt.gz'
REF_PANEL_DIR = os.getenv('REF_PANEL_DIR', f'{_REPO}/cache/topmed_reference')
NYGC_DIR = os.getenv('NYGC_1KG_DIR', '/media/techninja/gnomad/nygc_1kg')
WORK_DIR = os.getenv('LARGE_TMP', '/tmp') + '/asili_dr2'
OUTPUT_DIR = f'{_REPO}/data_out/dr2_lookup'


def run(cmd, **kwargs):
    kwargs.setdefault('check', True)
    return subprocess.run(cmd, **kwargs)


def fmt_dur(seconds):
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f'{h}h {m}m {s}s' if h else f'{m}m {s}s' if m else f'{s}s'


def get_array_positions():
    positions = {}
    for f in Path(f'{_REPO}/server-data/variants').glob('*.json'):
        data = json.load(open(f))
        for v in data['variants']:
            c = v.get('chromosome', '')
            if c.isdigit():
                positions.setdefault(int(c), set()).add(v['position'])
    return positions


def get_nygc_samples(n=None):
    result = run(['bcftools', 'query', '-l', f'{NYGC_DIR}/chr22.vcf.gz'],
                 capture_output=True, text=True)
    samples = result.stdout.strip().split('\n')
    return samples[:n] if n else samples


def run_chromosome(samples, chrom, positions, threads=4):
    """Full pipeline for one chromosome with resume support."""
    chr_work = f'{WORK_DIR}/chr{chrom}'
    Path(chr_work).mkdir(parents=True, exist_ok=True)
    dr2_file = f'{chr_work}/chr{chrom}_dr2.parquet'

    # Resume: skip if DR2 already computed
    if Path(dr2_file).exists():
        print(f'  ✓ chr{chrom} DR2 already exists, skipping')
        return dr2_file

    n = len(samples)
    t_total = time.monotonic()

    # Step 1: Mask NYGC to array positions
    masked_vcf = f'{chr_work}/chr{chrom}_masked.vcf.gz'
    if not Path(masked_vcf).exists():
        t0 = time.monotonic()
        print(f'  Masking chr{chrom} to {len(positions):,} array positions...')
        regions = f'{chr_work}/_regions.tsv'
        with open(regions, 'w') as f:
            for pos in sorted(positions):
                f.write(f'chr{chrom}\t{pos}\t{pos}\n')
        run(['bcftools', 'view', '-s', ','.join(samples), '-R', regions,
             '-O', 'z', '-o', masked_vcf, f'{NYGC_DIR}/chr{chrom}.vcf.gz'])
        run(['tabix', '-p', 'vcf', masked_vcf])
        os.remove(regions)
        print(f'    ⏱ {fmt_dur(time.monotonic()-t0)}')
    else:
        print(f'  ✓ chr{chrom} masked VCF exists, reusing')

    # Step 2: Extract truth (all NYGC variants for this chrom)
    truth_tsv = f'{chr_work}/chr{chrom}_truth.tsv'
    if not Path(truth_tsv).exists():
        t0 = time.monotonic()
        print(f'  Extracting truth for chr{chrom} ({n} samples)...')
        with open(truth_tsv, 'w') as fout:
            run(['bcftools', 'query', '-s', ','.join(samples),
                 '-f', '%CHROM:%POS:%REF:%ALT[\t%GT]\n',
                 f'{NYGC_DIR}/chr{chrom}.vcf.gz'], stdout=fout)
        print(f'    ⏱ {fmt_dur(time.monotonic()-t0)}')
    else:
        print(f'  ✓ chr{chrom} truth exists, reusing')

    # Step 3: Eagle phasing + Beagle imputation
    imputed_vcf = f'{chr_work}/chr{chrom}_imputed.vcf.gz'
    if not Path(imputed_vcf).exists():
        t0 = time.monotonic()
        ref_vcf = f'{REF_PANEL_DIR}/chr{chrom}.topmed.vcf.gz'
        ref_bcf = f'{REF_PANEL_DIR}/chr{chrom}.topmed.bcf'
        eagle_ref = ref_bcf if Path(ref_bcf).exists() else ref_vcf

        if Path(EAGLE_BIN).exists():
            print(f'  Phasing chr{chrom} with Eagle2...')
            phased_prefix = f'{chr_work}/chr{chrom}_phased'
            run([EAGLE_BIN, '--vcfTarget', masked_vcf, '--vcfRef', eagle_ref,
                 '--geneticMapFile', GENETIC_MAP, '--chrom', f'chr{chrom}',
                 '--outPrefix', phased_prefix, '--numThreads', str(threads),
                 '--vcfOutFormat', 'z'])
            phased_vcf = f'{phased_prefix}.vcf.gz'
            run(['tabix', '-p', 'vcf', phased_vcf])
        else:
            phased_vcf = masked_vcf

        print(f'  Imputing chr{chrom} with Beagle...')
        mem_gb = max(4, int(os.getenv('BEAGLE_MEM_GB', '20')))
        imputed_prefix = f'{chr_work}/chr{chrom}_imputed'
        run(['java', f'-Xmx{mem_gb}g', '-jar', BEAGLE_JAR,
             f'gt={phased_vcf}', f'ref={ref_vcf}', f'out={imputed_prefix}',
             'impute=true', 'gp=false', 'ne=20000', 'err=0.0005', 'seed=42',
             f'nthreads={threads}'])
        run(['tabix', '-p', 'vcf', imputed_vcf])

        # Cleanup phased
        if phased_vcf != masked_vcf:
            for f in [phased_vcf, phased_vcf + '.tbi']:
                if Path(f).exists(): os.remove(f)
        for f in Path(chr_work).glob('*.log'):
            f.unlink()
        print(f'    ⏱ Phase+Impute: {fmt_dur(time.monotonic()-t0)}')
    else:
        print(f'  ✓ chr{chrom} imputed VCF exists, reusing')

    # Step 4: Extract dosages
    dosage_tsv = f'{chr_work}/chr{chrom}_dosages.tsv'
    if not Path(dosage_tsv).exists():
        t0 = time.monotonic()
        print(f'  Extracting dosages for chr{chrom}...')
        with open(dosage_tsv, 'w') as fout:
            run(['bcftools', 'query', '-f', '%CHROM:%POS:%REF:%ALT[\t%DS]\n',
                 imputed_vcf], stdout=fout)
        print(f'    ⏱ {fmt_dur(time.monotonic()-t0)}')
    else:
        print(f'  ✓ chr{chrom} dosages exist, reusing')

    # Step 5: Compute DR2
    t0 = time.monotonic()
    _compute_dr2(truth_tsv, dosage_tsv, n, chrom, chr_work, dr2_file)
    print(f'    ⏱ DR2 computation: {fmt_dur(time.monotonic()-t0)}')

    # Cleanup large intermediates (keep dr2 parquet)
    for f in [truth_tsv, dosage_tsv, masked_vcf, masked_vcf + '.tbi',
              imputed_vcf, imputed_vcf + '.tbi']:
        if Path(f).exists():
            os.remove(f)

    print(f'  ✓ chr{chrom} complete in {fmt_dur(time.monotonic()-t_total)}')
    return dr2_file


def _compute_dr2(truth_tsv, dosage_tsv, n_samples, chrom, work_dir, out_path):
    """Merge-join truth+dosage TSVs, then compute corr² per variant."""
    import duckdb
    import pyarrow as pa
    import pyarrow.parquet as pq

    print(f'  Computing DR2 for chr{chrom}...')
    paired_pq = f'{work_dir}/chr{chrom}_paired.parquet'

    # Merge-join by variant ID (both files in genomic position order)
    def parse_gt(s):
        sep = '|' if '|' in s else '/'
        a = s.split(sep)
        return float(int(a[0]) + int(a[1]))

    def sort_key(vid):
        p = vid.split(':')
        return (p[0], int(p[1]), p[2], p[3])

    writer = None
    vids, vt, vd = [], [], []
    chunk = 50000 * n_samples
    matched = 0

    ft = open(truth_tsv)
    fd = open(dosage_tsv)
    lt = ft.readline()
    ld = fd.readline()

    while lt and ld:
        pt = lt.rstrip('\n').split('\t')
        pd_ = ld.rstrip('\n').split('\t')
        vt_id, vd_id = pt[0], pd_[0]

        if vt_id == vd_id:
            matched += 1
            ncols = min(n_samples, len(pt) - 1, len(pd_) - 1)
            for i in range(ncols):
                vids.append(vt_id)
                vt.append(parse_gt(pt[i + 1]))
                vd.append(float(pd_[i + 1]))
            if len(vids) >= chunk:
                tbl = pa.table({'vid': vids, 't': pa.array(vt, type=pa.float32()),
                                'd': pa.array(vd, type=pa.float32())})
                if writer is None:
                    writer = pq.ParquetWriter(paired_pq, tbl.schema, compression='zstd')
                writer.write_table(tbl)
                vids, vt, vd = [], [], []
            lt = ft.readline()
            ld = fd.readline()
        elif sort_key(vt_id) < sort_key(vd_id):
            lt = ft.readline()
        else:
            ld = fd.readline()

    ft.close()
    fd.close()

    if vids:
        tbl = pa.table({'vid': vids, 't': pa.array(vt, type=pa.float32()),
                        'd': pa.array(vd, type=pa.float32())})
        if writer is None:
            writer = pq.ParquetWriter(paired_pq, tbl.schema, compression='zstd')
        writer.write_table(tbl)
    if writer:
        writer.close()
    del vids, vt, vd
    print(f'    {matched:,} variants matched')

    # DuckDB: GROUP BY vid, compute corr(t,d)²
    con = duckdb.connect()
    con.execute(f"SET temp_directory='{work_dir}/duckdb_tmp'")
    con.execute("SET memory_limit='16GB'")
    con.execute(f"""
        COPY (
            SELECT regexp_replace(vid, '^chr', '') AS variant_id,
                   CAST(CASE WHEN var_pop(t) * var_pop(d) = 0 THEN 0.0
                        ELSE greatest(0, least(1, pow(corr(t, d), 2)))
                   END AS FLOAT) AS dr2
            FROM read_parquet('{paired_pq}')
            GROUP BY vid
        ) TO '{out_path}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)

    stats = con.execute(f"""
        SELECT count(*), round(avg(dr2),4), round(median(dr2),4),
               count(*) FILTER (WHERE dr2 >= 0.8),
               count(*) FILTER (WHERE dr2 < 0.3)
        FROM read_parquet('{out_path}')
    """).fetchone()
    con.close()

    if Path(paired_pq).exists():
        os.remove(paired_pq)
    import shutil
    duckdb_tmp = Path(f'{work_dir}/duckdb_tmp')
    if duckdb_tmp.exists():
        shutil.rmtree(duckdb_tmp, ignore_errors=True)

    print(f'    {stats[0]:,} variants: mean={stats[1]}, median={stats[2]}, '
          f'good(\u22650.8)={stats[3]:,}, poor(<0.3)={stats[4]:,}')


def merge_dr2(chr_parquets, output_path):
    import duckdb
    files = [p for p in chr_parquets if p and Path(p).exists()]
    if not files:
        print('No DR2 parquets to merge!')
        return
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    con.execute(f"SET temp_directory='{WORK_DIR}/duckdb_merge_tmp'")
    con.execute(f"""
        COPY (
            SELECT variant_id, dr2,
                   ('0x' || md5(LEAST(split_part(variant_id,':',3), split_part(variant_id,':',4))
                     || ':' || GREATEST(split_part(variant_id,':',3), split_part(variant_id,':',4))
                   )[:15])::BIGINT AS allele_key
            FROM read_parquet({files})
            ORDER BY TRY_CAST(split_part(variant_id,':',1) AS INT),
                     TRY_CAST(split_part(variant_id,':',2) AS INT)
        ) TO '{output_path}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    stats = con.execute(f"""
        SELECT count(*), round(avg(dr2),4), round(median(dr2),4)
        FROM read_parquet('{output_path}')
    """).fetchone()
    con.close()

    import shutil
    tmp = Path(f'{WORK_DIR}/duckdb_merge_tmp')
    if tmp.exists():
        shutil.rmtree(tmp, ignore_errors=True)

    print(f'\n✓ DR2 lookup: {stats[0]:,} variants, mean={stats[1]}, median={stats[2]}')
    print(f'  Written to: {output_path}')


def main():
    parser = argparse.ArgumentParser(description='Compute per-variant DR2 from NYGC truth data')
    parser.add_argument('--test', action='store_true', help='3 samples, chr22 only')
    parser.add_argument('--chroms', type=str, default=None, help='Comma-separated chromosomes')
    parser.add_argument('--threads', type=int, default=6, help='Threads for phasing/imputation')
    args = parser.parse_args()

    if args.test:
        n_samples = 3
        chromosomes = [22]
    else:
        n_samples = None  # all 3202
        chromosomes = [int(c) for c in args.chroms.split(',')] if args.chroms else list(range(1, 23))

    samples = get_nygc_samples(n_samples)
    Path(WORK_DIR).mkdir(parents=True, exist_ok=True)

    print(f'📊 DR2 Calibration Pipeline')
    print(f'   Samples: {len(samples)}')
    print(f'   Chromosomes: {chromosomes}')
    print(f'   Threads: {args.threads}')
    print(f'   Work dir: {WORK_DIR}')

    all_positions = get_array_positions()
    print(f'   Array positions: {sum(len(v) for v in all_positions.values()):,}')

    pipeline_start = time.monotonic()
    chr_parquets = []

    for chrom in chromosomes:
        positions = all_positions.get(chrom, set())
        if not positions:
            print(f'\n⚠ No array positions for chr{chrom}, skipping')
            continue
        print(f'\n{"="*50}')
        print(f'Chromosome {chrom} ({len(positions):,} array positions)')
        print(f'{"="*50}')
        dr2_pq = run_chromosome(samples, chrom, positions, args.threads)
        chr_parquets.append(dr2_pq)

    output_path = f'{OUTPUT_DIR}/dr2_lookup.parquet'
    merge_dr2(chr_parquets, output_path)

    print(f'\n✅ Done in {fmt_dur(time.monotonic()-pipeline_start)}')


if __name__ == '__main__':
    main()
