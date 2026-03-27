#!/usr/bin/env python3
"""
Phase 2: User Imputation Pipeline
Converts user DNA → BCF → Beagle imputation → filtered Parquet
"""
import sys
import signal
import subprocess
import json
from pathlib import Path
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

# Track child processes for clean shutdown
_child_procs = []
_shutting_down = False

def _cleanup_and_exit(signum=None, frame=None):
    """Kill all child processes and clean up temp files on interrupt."""
    global _shutting_down
    if _shutting_down:
        return
    _shutting_down = True
    print(f"\n\n⚠️  Interrupted — cleaning up...")
    for proc in _child_procs:
        try:
            proc.kill()
        except (OSError, ProcessLookupError):
            pass
    if Path(TEMP_DIR).exists():
        import shutil
        shutil.rmtree(TEMP_DIR, ignore_errors=True)
        print(f"  Removed {TEMP_DIR}")
    print("  Done. Exiting.")
    sys.exit(1)

signal.signal(signal.SIGINT, _cleanup_and_exit)
signal.signal(signal.SIGTERM, _cleanup_and_exit)

def _run(cmd, **kwargs):
    """subprocess.run wrapper that tracks child processes for clean shutdown."""
    # Translate subprocess.run convenience kwargs to Popen equivalents
    if kwargs.pop('capture_output', False):
        kwargs.setdefault('stdout', subprocess.PIPE)
        kwargs.setdefault('stderr', subprocess.PIPE)
    check = kwargs.pop('check', False)
    input_data = kwargs.pop('input', None)
    text = kwargs.pop('text', False)
    if text:
        kwargs['encoding'] = 'utf-8'
    if input_data is not None:
        kwargs.setdefault('stdin', subprocess.PIPE)
    proc = subprocess.Popen(cmd, **kwargs)
    _child_procs.append(proc)
    try:
        stdout, stderr = proc.communicate(input=input_data)
    finally:
        if proc in _child_procs:
            _child_procs.remove(proc)
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd, stdout, stderr)
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)

BEAGLE_JAR = os.getenv('BEAGLE_DIR', './tools/beagle') + '/beagle.jar'
EAGLE_BIN = os.getenv('EAGLE_DIR', './tools/eagle') + '/eagle'
GENETIC_MAP = os.getenv('EAGLE_DIR', './tools/eagle') + '/genetic_map_hg38_withX.txt.gz'
CHAIN_FILE = os.getenv('LIFTOVER_DIR', './tools/liftover') + '/hg19ToHg38.over.chain.gz'
HG38_FASTA = os.getenv('LIFTOVER_DIR', './tools/liftover') + '/hg38.fa'
REF_PANEL_DIR = os.getenv('REF_PANEL_DIR', './cache/topmed_reference')
OUTPUT_DIR = './server-data/imputed'
TEMP_DIR = os.getenv('LARGE_TMP', '/tmp') + '/asili_imputation'

# Parallelism: run N chromosomes concurrently, splitting threads/RAM across them
TOTAL_THREADS = int(os.getenv('IMPUTE_THREADS', os.cpu_count() or 8))
PARALLEL_CHROMS = int(os.getenv('IMPUTE_PARALLEL', min(2, TOTAL_THREADS // 4) or 1))
THREADS_PER_JOB = max(1, TOTAL_THREADS // PARALLEL_CHROMS)

# Complement map for strand-flip detection
COMPLEMENT = {'A': 'T', 'T': 'A', 'C': 'G', 'G': 'C'}

def _load_chr_ref_alleles(args):
    """Worker: extract chr:pos → REF from one chromosome VCF."""
    chrom, ref_vcf = args
    result = _run(
        ['bcftools', 'query', '-f', '%CHROM\t%POS\t%REF\n', ref_vcf],
        capture_output=True, text=True
    )
    partial = {}
    for line in result.stdout.split('\n'):
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) >= 3:
            c = parts[0].replace('chr', '')
            partial[f"{c}:{parts[1]}"] = parts[2][0]
    print(f"    chr{chrom}: {len(partial):,} REF alleles")
    return partial

def build_ref_allele_lookup(panel_dir, chromosomes=None):
    """Build chr:pos → REF allele lookup from reference panel.
    
    Caches to a pickle file alongside the panel for instant reuse.
    """
    if chromosomes is None:
        chromosomes = range(1, 23)

    cache_path = Path(panel_dir) / 'ref_alleles.pkl'
    if cache_path.exists():
        import pickle
        with open(cache_path, 'rb') as f:
            lookup = pickle.load(f)
        print(f"  ✓ Loaded {len(lookup):,} REF alleles from cache")
        return lookup

    jobs = []
    for chrom in chromosomes:
        ref_vcf = f"{panel_dir}/chr{chrom}.topmed.vcf.gz"
        if Path(ref_vcf).exists():
            jobs.append((chrom, ref_vcf))

    lookup = {}
    with ThreadPoolExecutor(max_workers=min(8, len(jobs))) as pool:
        for partial in pool.map(_load_chr_ref_alleles, jobs):
            lookup.update(partial)

    # Cache for next run
    import pickle
    with open(cache_path, 'wb') as f:
        pickle.dump(lookup, f, protocol=pickle.HIGHEST_PROTOCOL)

    print(f"  ✓ Loaded {len(lookup):,} REF alleles from reference panel (cached)")
    return lookup

def detect_build(user_file):
    """Detect genome build from user DNA JSON or original file header.
    
    AncestryDNA headers contain 'build 37.1', 23andMe uses 'build 37'.
    Falls back to probing known SNP positions against TOPMed (hg38).
    """
    with open(user_file) as f:
        data = json.load(f)

    # Check if build was stored in metadata
    build = data.get('metadata', {}).get('build')
    if build:
        return build

    # Probe: rs3131972 is at chr1:752721 in hg19, chr1:817186 in hg38
    # If the file has it at 752721, it's hg19
    for v in data['variants']:
        if v.get('rsid') == 'rs3131972':
            pos = v.get('position', 0)
            if 752000 <= pos <= 753000:
                print(f"  Build detected: hg19 (rs3131972 at {pos})")
                return 'hg19'
            elif 817000 <= pos <= 818000:
                print(f"  Build detected: hg38 (rs3131972 at {pos})")
                return 'hg38'
            break

    # Default assumption: most consumer arrays are hg19/GRCh37
    print(f"  Build detection inconclusive, assuming hg19")
    return 'hg19'

def convert_to_vcf(user_file, user_id, ref_allele_lookup=None, build='hg38'):
    """Convert user DNA JSON file to VCF.gz with proper REF/ALT assignment."""
    print(f"Converting {user_file} to VCF...")
    
    Path(TEMP_DIR).mkdir(parents=True, exist_ok=True)
    
    with open(user_file) as f:
        data = json.load(f)
    
    variants = data['variants']
    
    output_vcf = f"{TEMP_DIR}/{user_id}_raw.vcf"
    output_vcf_gz = f"{TEMP_DIR}/{user_id}_raw.vcf.gz"
    
    valid_alleles = {'A', 'C', 'G', 'T'}
    stats = {'total': 0, 'ref_matched': 0, 'strand_flipped': 0, 'hom_alt': 0, 'skipped': 0}
    
    with open(output_vcf, 'w') as out:
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
            
            if chrom not in [str(i) for i in range(1, 23)] + ['X', 'Y', 'MT']:
                continue
            if (not allele1 or not allele2 or
                allele1 not in valid_alleles or allele2 not in valid_alleles):
                continue
            
            stats['total'] += 1
            
            # Determine REF allele from reference panel when available
            panel_ref = ref_allele_lookup.get(f"{chrom}:{pos}") if ref_allele_lookup else None
            
            if panel_ref:
                # Check for strand flip: if neither allele matches REF but
                # complements do, flip both alleles to the correct strand
                if panel_ref not in (allele1, allele2):
                    comp1 = COMPLEMENT.get(allele1, '')
                    comp2 = COMPLEMENT.get(allele2, '')
                    if panel_ref in (comp1, comp2):
                        allele1, allele2 = comp1, comp2
                        stats['strand_flipped'] += 1
                    else:
                        stats['skipped'] += 1
                        continue  # Alleles incompatible with reference
                
                ref = panel_ref
                stats['ref_matched'] += 1
                
                if allele1 == ref and allele2 == ref:
                    alt = [a for a in valid_alleles if a != ref][0]
                    gt = "0/0"
                elif allele1 == ref:
                    alt = allele2
                    gt = "0/1"
                elif allele2 == ref:
                    alt = allele1
                    gt = "0/1"
                else:
                    # Both alleles are ALT (hom-alt)
                    alt = allele1
                    gt = "1/1"
                    stats['hom_alt'] += 1
            else:
                # Fallback: no reference info, use alphabetical ordering
                if allele1 == allele2:
                    ref = allele1
                    alt = [a for a in valid_alleles if a != ref][0]
                    gt = "0/0"
                else:
                    ref, alt = sorted([allele1, allele2])
                    gt = "0/1"
            
            out.write(f"{chrom}\t{pos}\t{rsid}\t{ref}\t{alt}\t.\tPASS\t.\tGT\t{gt}\n")
    
    # Compress and index VCF
    with open(output_vcf_gz, 'wb') as gz_out:
        _run(['bgzip', '-c', output_vcf], stdout=gz_out, check=True)
    _run(['tabix', '-p', 'vcf', output_vcf_gz], check=True)
    
    os.remove(output_vcf)
    
    print(f"✓ VCF created: {output_vcf_gz}")
    print(f"  Variants: {stats['total']:,} total, {stats['ref_matched']:,} ref-matched, "
          f"{stats['strand_flipped']:,} strand-flipped, {stats['hom_alt']:,} hom-alt, "
          f"{stats['skipped']:,} skipped")
    return output_vcf_gz

def liftover_vcf(vcf_gz, user_id, build):
    """Liftover VCF from hg19/GRCh37 to hg38/GRCh38 using CrossMap."""
    if build == 'hg38':
        return vcf_gz

    print(f"Lifting over from {build} to hg38...")
    from cmmodule import read_chain_file, crossmap_vcf_file

    lifted_vcf = f"{TEMP_DIR}/{user_id}_hg38.vcf"
    unmap_vcf = f"{TEMP_DIR}/{user_id}_hg38.vcf.unmap"

    mapTree, _, _ = read_chain_file(CHAIN_FILE)
    crossmap_vcf_file(
        mapping=mapTree,
        infile=vcf_gz,
        outfile=lifted_vcf,
        liftoverfile=HG38_FASTA,
        refgenome=HG38_FASTA,
    )

    # Count results
    lifted_count = sum(1 for l in open(lifted_vcf) if not l.startswith('#'))
    unmap_count = sum(1 for l in open(unmap_vcf) if not l.startswith('#')) if Path(unmap_vcf).exists() else 0

    # Filter to standard chroms, add contig headers, sort, compress, index
    reheadered_vcf = f"{TEMP_DIR}/{user_id}_hg38_rh.vcf"
    valid_chroms = set(str(i) for i in range(1, 23)) | {'X', 'Y', 'MT'}
    contigs = ''.join(f'##contig=<ID={c}>\n' for c in sorted(valid_chroms, key=lambda x: int(x) if x.isdigit() else 99))
    with open(lifted_vcf) as fin, open(reheadered_vcf, 'w') as fout:
        for line in fin:
            if line.startswith('#CHROM'):
                fout.write(contigs)
                fout.write(line)
            elif line.startswith('#'):
                fout.write(line)
            else:
                chrom = line.split('\t', 1)[0]
                if chrom in valid_chroms:
                    fout.write(line)
    os.remove(lifted_vcf)

    sorted_vcf = f"{TEMP_DIR}/{user_id}_hg38_sorted.vcf.gz"
    _run(['bcftools', 'sort', '-O', 'z', '-o', sorted_vcf, reheadered_vcf], check=True)
    _run(['tabix', '-p', 'vcf', sorted_vcf], check=True)
    os.remove(reheadered_vcf)
    os.remove(vcf_gz)
    os.remove(vcf_gz + '.tbi')
    if Path(unmap_vcf).exists():
        os.remove(unmap_vcf)

    print(f"✓ Liftover: {lifted_count:,} mapped, {unmap_count:,} unmapped")
    return sorted_vcf

def _get_chr_vcf(user_vcf, user_id, chromosome):
    """Extract chromosome-specific VCF and rename to chr-prefixed contigs for TOPMed."""
    chr_vcf = f"{TEMP_DIR}/{user_id}_chr{chromosome}.vcf.gz"
    _run([
        'bcftools', 'view',
        '-r', str(chromosome),
        '-O', 'z', '-o', chr_vcf,
        user_vcf
    ], check=True)
    _run(['tabix', '-p', 'vcf', chr_vcf], check=True)

    renamed = f"{TEMP_DIR}/{user_id}_chr{chromosome}_renamed.vcf.gz"
    _run([
        'bcftools', 'annotate',
        '--rename-chrs', '/dev/stdin',
        '-O', 'z', '-o', renamed,
        chr_vcf
    ], input=f"{chromosome}\tchr{chromosome}\n".encode(), check=True)
    _run(['tabix', '-p', 'vcf', renamed], check=True)
    os.remove(chr_vcf)
    os.remove(chr_vcf + '.tbi')
    return renamed

def _get_ref_panel(chromosome, prefer_bcf=False):
    """Get reference panel path for a chromosome.
    
    Eagle2 reads BCF ~3x faster. Beagle 5.4 only reads .vcf/.vcf.gz/.bref3.
    """
    bcf = f"{REF_PANEL_DIR}/chr{chromosome}.topmed.bcf"
    vcf = f"{REF_PANEL_DIR}/chr{chromosome}.topmed.vcf.gz"
    if prefer_bcf and Path(bcf).exists():
        return bcf
    if Path(vcf).exists():
        return vcf
    raise FileNotFoundError(f"Reference panel not found for chr{chromosome}")

def run_eagle_phasing(user_vcf, user_id, chromosome):
    """Run Eagle2 pre-phasing for one chromosome.
    
    Eagle2 is specifically optimized for phasing sparse array data against
    a reference panel. Separate phasing produces better haplotype estimates
    than Beagle's built-in phasing, especially for consumer arrays.
    """
    print(f"  Phasing chr{chromosome} with Eagle2...")

    chr_vcf = _get_chr_vcf(user_vcf, user_id, chromosome)
    ref_panel = _get_ref_panel(chromosome, prefer_bcf=True)
    output_prefix = f"{TEMP_DIR}/{user_id}_chr{chromosome}_phased"
    chrom_name = f"chr{chromosome}"

    cmd = [
        EAGLE_BIN,
        '--vcfTarget', chr_vcf,
        '--vcfRef', ref_panel,
        '--geneticMapFile', GENETIC_MAP,
        '--chrom', chrom_name,
        '--outPrefix', output_prefix,
        '--numThreads', str(THREADS_PER_JOB),
        '--vcfOutFormat', 'z',  # gzipped VCF output
    ]

    _run(cmd, check=True)

    # Cleanup unphased chr VCF
    os.remove(chr_vcf)
    os.remove(chr_vcf + '.tbi')

    phased_vcf = f"{output_prefix}.vcf.gz"
    _run(['tabix', '-p', 'vcf', phased_vcf], check=True)
    return phased_vcf

def run_beagle_imputation(phased_vcf, user_id, chromosome):
    """Run Beagle imputation for one chromosome using pre-phased input."""
    print(f"  Imputing chr{chromosome}...")

    ref_panel = _get_ref_panel(chromosome, prefer_bcf=False)
    output_prefix = f"{TEMP_DIR}/{user_id}_chr{chromosome}_imputed"

    mem_per_job = max(4, 16 // PARALLEL_CHROMS)
    cmd = [
        'java', f'-Xmx{mem_per_job}g', '-jar', BEAGLE_JAR,
        f'gt={phased_vcf}',
        f'ref={ref_panel}',
        f'out={output_prefix}',
        'impute=true',
        'gp=true',
        'ap=true',
        'ne=20000',
        'err=0.0005',
        'seed=42',
        f'nthreads={THREADS_PER_JOB}'
    ]

    _run(cmd, check=True)

    # Cleanup phased input
    os.remove(phased_vcf)
    os.remove(phased_vcf + '.tbi')

    return f"{output_prefix}.vcf.gz"

def convert_to_bcf(imputed_vcf, user_id, chromosome):
    """Convert imputed VCF to BCF (no filtering - keep all variants)."""
    # Index the imputed VCF
    _run(['tabix', '-p', 'vcf', imputed_vcf], check=True, capture_output=True)
    
    # Convert to BCF without filtering
    output_bcf = f"{TEMP_DIR}/{user_id}_chr{chromosome}.bcf"
    
    _run([
        'bcftools', 'view',
        '--threads', '2',
        '-O', 'b',
        '-o', output_bcf,
        imputed_vcf
    ], check=True, capture_output=True)
    
    os.remove(imputed_vcf)
    os.remove(imputed_vcf + '.tbi')
    
    return output_bcf

def bcf_to_chr_parquet(bcf_file, user_id, chromosome):
    """Convert one chromosome's BCF to Parquet via DuckDB.
    
    Pipes bcftools query to TSV, then DuckDB parses/filters/writes parquet.
    No Python loops over millions of rows.
    """
    import duckdb
    
    _run(['bcftools', 'index', '-f', bcf_file], check=True)
    
    tsv_file = f"{TEMP_DIR}/{user_id}_chr{chromosome}_query.tsv"
    with open(tsv_file, 'w') as fout:
        _run(
            ['bcftools', 'query', '-f', '%CHROM:%POS:%REF:%ALT\t[%DS]\t[%GP]\n', bcf_file],
            stdout=fout, check=True
        )
    
    chr_parquet = f"{TEMP_DIR}/{user_id}_chr{chromosome}_imputed.parquet"
    con = duckdb.connect()
    con.execute(f"""
        COPY (
            SELECT
                regexp_replace(vid, '^chr', '') AS variant_id,
                CAST(ds AS FLOAT) AS genotype_dosage,
                CAST(greatest(gp1, gp2, gp3) AS FLOAT) AS imputation_quality
            FROM (
                SELECT
                    column0 AS vid,
                    column1 AS ds,
                    CAST(split_part(column2, ',', 1) AS DOUBLE) AS gp1,
                    CAST(split_part(column2, ',', 2) AS DOUBLE) AS gp2,
                    CAST(split_part(column2, ',', 3) AS DOUBLE) AS gp3
                FROM read_csv('{tsv_file}', sep='\t', header=false, all_varchar=true)
            )
            WHERE greatest(gp1, gp2, gp3) >= 0.5
        ) TO '{chr_parquet}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    count = con.execute(f"SELECT count(*) FROM read_parquet('{chr_parquet}')").fetchone()[0]
    con.close()
    
    os.remove(tsv_file)
    os.remove(bcf_file)
    if Path(bcf_file + '.csi').exists():
        os.remove(bcf_file + '.csi')
    
    return chr_parquet, count


def merge_chr_parquets(chr_parquets, user_id):
    """Concatenate per-chromosome parquets into final imputed file."""
    import duckdb
    
    output_parquet = f"{OUTPUT_DIR}/{user_id}_imputed.parquet"
    files = [p for p in chr_parquets if p and Path(p).exists()]
    
    con = duckdb.connect()
    con.execute(f"""
        COPY (SELECT * FROM read_parquet({files}))
        TO '{output_parquet}' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    total = con.execute(f"SELECT count(*) FROM read_parquet('{output_parquet}')").fetchone()[0]
    con.close()
    
    for p in files:
        os.remove(p)
    
    print(f"\u2713 {total:,} imputed variants saved")
    return output_parquet

def merge_with_genotyped(user_file, imputed_parquet, user_id):
    """Merge genotyped variants with imputed variants into unified file.
    
    Uses DuckDB to avoid materializing 70M rows as Python objects.
    The old approach (.to_pylist() on 70M rows) used 30GB+ RAM.
    """
    print(f"\nMerging with genotyped variants...")
    
    import duckdb
    import pyarrow as pa
    import pyarrow.parquet as pq
    
    # Build genotyped table from user JSON
    with open(user_file) as f:
        data = json.load(f)
    
    valid_chroms = set(str(i) for i in range(1, 23)) | {'X', 'Y', 'MT'}
    valid_alleles = {'A', 'C', 'G', 'T'}
    g_vids, g_dosages = [], []
    
    for v in data['variants']:
        c, p = v.get('chromosome', ''), v.get('position', 0)
        a1, a2 = v.get('allele1', ''), v.get('allele2', '')
        if c not in valid_chroms or a1 not in valid_alleles or a2 not in valid_alleles:
            continue
        ref, alt = sorted([a1, a2])
        g_vids.append(f"{c}:{p}:{ref}:{alt}")
        g_dosages.append(0.0 if a1 == a2 and a1 == ref else 2.0 if a1 == a2 else 1.0)
    
    genotyped = pa.table({
        'variant_id': pa.array(g_vids),
        'genotype_dosage': pa.array(g_dosages, type=pa.float32()),
        'imputed': pa.array([False] * len(g_vids), type=pa.bool_()),
        'imputation_quality': pa.array([1.0] * len(g_vids), type=pa.float32()),
    })
    print(f"  ✓ {len(g_vids):,} genotyped variants")
    del g_vids, g_dosages, data
    
    # Use DuckDB to filter imputed (exclude genotyped positions) and union
    con = duckdb.connect()
    con.register('genotyped', genotyped)
    
    con.execute(f"""
        COPY (
            SELECT variant_id, genotype_dosage, imputed, imputation_quality,
                   CASE split_part(variant_id,':',1)
                       WHEN 'X' THEN 23 WHEN 'Y' THEN 24 WHEN 'MT' THEN 25
                       ELSE TRY_CAST(split_part(variant_id,':',1) AS TINYINT)
                   END AS chr,
                   TRY_CAST(split_part(variant_id,':',2) AS INTEGER) AS pos
            FROM (
                SELECT * FROM genotyped
                UNION ALL
                SELECT variant_id, genotype_dosage, true AS imputed, imputation_quality
                FROM read_parquet('{imputed_parquet}')
                WHERE split_part(variant_id,':',1) || ':' || split_part(variant_id,':',2)
                    NOT IN (SELECT split_part(variant_id,':',1) || ':' || split_part(variant_id,':',2) FROM genotyped)
            )
            ORDER BY chr, pos
        ) TO '{TEMP_DIR}/unified_tmp.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
    """)
    
    counts = con.execute(f"""
        SELECT
            (SELECT count(*) FROM genotyped) AS genotyped,
            (SELECT count(*) FROM read_parquet('{TEMP_DIR}/unified_tmp.parquet') WHERE imputed) AS imputed,
            (SELECT count(*) FROM read_parquet('{TEMP_DIR}/unified_tmp.parquet')) AS total
    """).fetchone()
    con.close()
    del genotyped
    
    unified_dir = f"{OUTPUT_DIR}/../unified"
    Path(unified_dir).mkdir(parents=True, exist_ok=True)
    unified_file = f"{unified_dir}/{user_id}.parquet"
    os.rename(f"{TEMP_DIR}/unified_tmp.parquet", unified_file)
    
    print(f"✓ Unified file created: {unified_file}")
    print(f"  Genotyped: {counts[0]:,}")
    print(f"  Imputed: {counts[1]:,}")
    print(f"  Total: {counts[2]:,}")
    
    return unified_file

def _fmt_duration(seconds):
    """Format seconds into human-readable duration."""
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"

def main(user_file, user_id_with_name):
    """Run full imputation pipeline."""
    import time
    pipeline_start = time.monotonic()
    timings = {}
    
    Path(OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
    
    # Extract just the numeric ID for VCF sample name (Beagle requirement)
    user_id_numeric = user_id_with_name.split('_')[0]
    
    if not Path(f"{REF_PANEL_DIR}/chr1.topmed.vcf.gz").exists():
        print(f"❌ TOPMed reference panel not found in {REF_PANEL_DIR}")
        print(f"   Run: pnpm imputation setup")
        sys.exit(1)

    print(f"\n🧬 Imputation Pipeline for {user_id_with_name}")
    print(f"📁 Panel Directory: {REF_PANEL_DIR}\n")
    
    # Step 0: Detect genome build
    t0 = time.monotonic()
    build = detect_build(user_file)

    # Step 0.5: Build REF allele lookup from reference panel
    print(f"Building REF allele lookup from reference panel...")
    ref_lookup = build_ref_allele_lookup(REF_PANEL_DIR)
    timings['Prep (build detect + REF lookup)'] = time.monotonic() - t0
    
    # Step 1: Convert to VCF.gz with proper REF/ALT (use numeric ID for VCF sample column)
    t0 = time.monotonic()
    user_vcf = convert_to_vcf(user_file, user_id_numeric, ref_allele_lookup=ref_lookup)
    timings['VCF conversion'] = time.monotonic() - t0
    
    # Step 1.5: Liftover hg19 → hg38 if needed
    t0 = time.monotonic()
    user_vcf = liftover_vcf(user_vcf, user_id_numeric, build=build)
    timings['Liftover'] = time.monotonic() - t0
    
    # Step 2: Eagle2 phasing → Beagle imputation per chromosome
    eagle_available = Path(EAGLE_BIN).exists() and Path(GENETIC_MAP).exists()
    if eagle_available:
        print(f"\nRunning Eagle2 phasing + Beagle imputation (this will take 2-3 hours)...")
    else:
        print(f"\nEagle2 not found, running Beagle phasing+imputation (this will take 1-2 hours)...")
        print(f"  💡 Install Eagle2 for better accuracy: pnpm imputation setup")
    
    print(f"  Parallelism: {PARALLEL_CHROMS} chromosomes × {THREADS_PER_JOB} threads")

    t0 = time.monotonic()
    def _process_chromosome(chrom):
        """Run full Eagle2→Beagle→BCF→Parquet pipeline for one chromosome."""
        if eagle_available:
            phased_vcf = run_eagle_phasing(user_vcf, user_id_numeric, chrom)
            imputed_vcf = run_beagle_imputation(phased_vcf, user_id_numeric, chrom)
        else:
            chr_vcf = _get_chr_vcf(user_vcf, user_id_numeric, chrom)
            imputed_vcf = run_beagle_imputation(chr_vcf, user_id_numeric, chrom)
        bcf_file = convert_to_bcf(imputed_vcf, user_id_numeric, chrom)
        chr_pq, count = bcf_to_chr_parquet(bcf_file, user_id_with_name, chrom)
        print(f"  ✓ chr{chrom} complete ({count:,} variants)")
        return chrom, chr_pq

    chr_parquets = [None] * 22

    with ThreadPoolExecutor(max_workers=PARALLEL_CHROMS) as executor:
        futures = {executor.submit(_process_chromosome, c): c for c in range(1, 23)}
        for future in as_completed(futures):
            chrom, chr_pq = future.result()
            chr_parquets[chrom - 1] = chr_pq
    timings['Phasing + Imputation (22 chroms)'] = time.monotonic() - t0
    
    # Step 4: Merge per-chromosome parquets
    t0 = time.monotonic()
    print(f"\nFinalizing...")
    parquet_file = merge_chr_parquets(chr_parquets, user_id_with_name)
    timings['Merge chr parquets'] = time.monotonic() - t0
    
    # Step 5: Merge with genotyped to create unified file
    t0 = time.monotonic()
    unified_file = merge_with_genotyped(user_file, parquet_file, user_id_with_name)
    timings['Merge with genotyped'] = time.monotonic() - t0
    
    # Cleanup
    os.remove(user_vcf)
    os.remove(user_vcf + '.tbi')
    
    total = time.monotonic() - pipeline_start
    print(f"\n✅ Imputation complete!")
    print(f"  Imputed file: {parquet_file}")
    print(f"  Unified file: {unified_file}")
    print(f"\n⏱  Benchmark:")
    for step, dur in timings.items():
        print(f"  {step:.<40s} {_fmt_duration(dur):>10s}")
    print(f"  {'Total':.<40s} {_fmt_duration(total):>10s}\n")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python3 impute_user.py <user_dna_file> <user_id_with_name>")
        print("Example: python3 impute_user.py ./server-data/variants/1769791316003_Ethan.json 1769791316003_Ethan")
        sys.exit(1)
    
    main(sys.argv[1], sys.argv[2])
