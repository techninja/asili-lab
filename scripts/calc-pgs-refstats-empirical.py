#!/usr/bin/env python3
"""
Compute empirical PGS normalization parameters by scoring NYGC 30x 1000 Genomes
reference individuals against all trait pack variants.

Replaces the theoretical TOPMed AF approach which assumed independent variants
and produced unrealistic z-scores.

Three phases, all resumable via cached intermediates:
  1. Download — Fetch NYGC 30x phased VCFs if not present
  2. Extract  — Stream each VCF, keep only pack positions, write per-chr parquet
  3. Score    — For each chromosome: load dosage as uint8 (~1-5 GB), read each
               trait's per-chr parquet from .asili tars (tiny), score via numpy
               matmul, accumulate. Peak memory ≈ one chromosome's dosage.

Usage:
  python3 scripts/calc-pgs-refstats-empirical.py [--chr N] [--reset]

Environment:
  NYGC_1KG_DIR  — where to store/find NYGC 30x VCFs (~26GB)
  LARGE_TMP     — temp dir for extracted genotype parquets
  DUCKDB_THREADS / DUCKDB_MEMORY_LIMIT — performance tuning
"""
import sys
import os
import io
import json
import time
import gc
import hashlib
import resource
import subprocess
import tarfile
import urllib.request
import shutil
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

# Force Arrow to use system malloc instead of mimalloc/jemalloc.
# mimalloc doesn't return freed memory to the OS, causing OOM on large workloads.
os.environ.setdefault("ARROW_DEFAULT_MEMORY_POOL", "system")
pa.set_memory_pool(pa.system_memory_pool())

# ── Config ───────────────────────────────────────────────────────────────────

def load_env():
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        for line in open(env_path):
            if line.strip() and not line.startswith("#") and "=" in line:
                k, v = line.strip().split("=", 1)
                if k not in os.environ:
                    os.environ[k] = v

load_env()

ROOT = Path(__file__).resolve().parent.parent
PACKS_DIR = ROOT / "data_out" / "packs"

MANIFEST_DB = ROOT / "data_out" / "trait_manifest.db"
OUTPUT_JSON = ROOT / "data_out" / "pgs_norm_params.json"

NYGC_DIR = Path(os.environ.get(
    "NYGC_1KG_DIR",
    os.environ.get("LARGE_TMP", "/tmp") + "/nygc_1kg"
))
EXTRACT_DIR = Path(os.environ.get("LARGE_TMP", "/tmp")) / "nygc_extracted"
TMP_DIR = os.environ.get("LARGE_TMP", "/tmp")

DB_THREADS = int(os.environ.get("DUCKDB_THREADS", "4"))
DB_MEMORY = os.environ.get("DUCKDB_MEMORY_LIMIT", "8GB")

NYGC_BASE_URL = (
    "http://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/"
    "1000G_2504_high_coverage/working/"
    "20220422_3202_phased_SNV_INDEL_SV"
)
ASILI_DIR = PACKS_DIR / "asili"

CHROMS = list(range(1, 23))
MISSING = 255
COL_CHUNK = 200  # columns per Arrow read batch


SCORE_CACHE_DIR = EXTRACT_DIR / "scores"
MATCH_CACHE_DIR = EXTRACT_DIR / "matches"

TIER_COVERAGES = {"raw": 0.13, "imputed": 0.60}
TIER_ITERATIONS = 10
RAW_TIER_ITERATIONS = 1  # deterministic array mask, no randomness needed


def rss_gb():
    """Current process RSS in GB (not peak)."""
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / (1024 * 1024)  # KB → GB
    except Exception:
        pass
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)


def compute_allele_key(a1, a2):
    lo, hi = (a1, a2) if a1 < a2 else (a2, a1)
    h = hashlib.md5(f"{lo}:{hi}".encode()).hexdigest()
    return int(f"0x{h[:15]}", 16)


# ── Phase 1: Download ───────────────────────────────────────────────────────

def download_file(url, dest):
    dest = Path(dest)
    partial = dest.with_suffix(dest.suffix + ".partial")
    if dest.exists():
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    expected_bytes = None
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=10) as resp:
            cl = resp.headers.get("Content-Length")
            if cl:
                expected_bytes = int(cl)
    except Exception:
        pass
    size_mb = f"{expected_bytes / 1048576:.0f}" if expected_bytes else "?"
    print(f"    Downloading ({size_mb} MB)...", flush=True)
    start = time.monotonic()
    try:
        urllib.request.urlretrieve(url, str(partial))
        actual_bytes = partial.stat().st_size
        # Validate: reject if we got less than 90% of expected size
        if expected_bytes and actual_bytes < expected_bytes * 0.9:
            print(f"    ✗ Truncated: got {actual_bytes:,} of {expected_bytes:,} bytes",
                  flush=True)
            partial.unlink()
            return False
        partial.rename(dest)
        elapsed = time.monotonic() - start
        print(f"    ✓ {actual_bytes / 1048576:.0f} MB in {elapsed:.0f}s", flush=True)
        return True
    except Exception as e:
        print(f"    ✗ Failed: {e}", flush=True)
        if partial.exists():
            partial.unlink()
        return False


def ensure_nygc_vcfs(chroms):
    print(f"\n📥 Phase 1: Ensure NYGC 30x VCFs in {NYGC_DIR}\n")
    NYGC_DIR.mkdir(parents=True, exist_ok=True)
    needed = []
    for c in chroms:
        vcf = NYGC_DIR / f"chr{c}.vcf.gz"
        tbi = NYGC_DIR / f"chr{c}.vcf.gz.tbi"
        if vcf.exists() and tbi.exists():
            print(f"  chr{c}: ✓ cached", flush=True)
        else:
            needed.append(c)
    if not needed:
        print("  All VCFs present.\n")
        return True
    print(f"  Need to download: {', '.join(f'chr{c}' for c in needed)}\n")
    for c in needed:
        fname = (f"1kGP_high_coverage_Illumina.chr{c}"
                 f".filtered.SNV_INDEL_SV_phased_panel")
        print(f"  chr{c} VCF:", flush=True)
        if not download_file(f"{NYGC_BASE_URL}/{fname}.vcf.gz",
                             NYGC_DIR / f"chr{c}.vcf.gz"):
            return False
        print(f"  chr{c} index:", flush=True)
        if not download_file(f"{NYGC_BASE_URL}/{fname}.vcf.gz.tbi",
                             NYGC_DIR / f"chr{c}.vcf.gz.tbi"):
            return False
    return True


# ── Phase 2: Extract genotypes at pack positions ────────────────────────────

def get_pack_positions_for_chr(chrom):
    """Get unique (pos, allele_key) from all packs for one chromosome."""
    con = duckdb.connect()
    con.execute(f"SET temp_directory='{TMP_DIR}'")
    con.execute(f"SET memory_limit='{DB_MEMORY}'")
    con.execute(f"SET threads TO {DB_THREADS}")
    rows = con.execute(f"""
        SELECT DISTINCT pos, allele_key
        FROM read_parquet('{PACKS_DIR}/*.parquet')
        WHERE chr = {chrom}
    """).fetchall()
    con.close()
    return rows


def get_sample_names(chrom=22):
    vcf = NYGC_DIR / f"chr{chrom}.vcf.gz"
    proc = subprocess.run(
        ["bcftools", "query", "-l", str(vcf)],
        capture_output=True, text=True, check=True,
    )
    return proc.stdout.strip().split("\n")


def extract_chromosome(chrom, sample_names):
    """Stream a NYGC VCF, extract genotype dosages at pack positions → parquet.

    Dosage = count of GREATEST(ref, alt) allele (0, 1, or 2).
    Missing = 255 sentinel.
    """
    out_path = EXTRACT_DIR / f"chr{chrom}.parquet"
    if out_path.exists():
        size_mb = out_path.stat().st_size / 1048576
        print(f"  chr{chrom}: ✓ cached ({size_mb:.1f} MB)", flush=True)
        return out_path

    vcf = NYGC_DIR / f"chr{chrom}.vcf.gz"
    if not vcf.exists():
        print(f"  chr{chrom}: ✗ VCF not found")
        return None

    print(f"  chr{chrom}: loading pack positions...", end="", flush=True)
    start = time.monotonic()
    pack_rows = get_pack_positions_for_chr(chrom)
    elapsed = time.monotonic() - start
    print(f" {len(pack_rows):,} ({elapsed:.0f}s)", flush=True)

    if not pack_rows:
        return None

    pos_lookup = {}
    for pos, ak in pack_rows:
        pos_lookup.setdefault(pos, set()).add(ak)

    n_samples = len(sample_names)
    col_pos = []
    col_ak = []
    BLOCK = 100_000
    dosage_blocks = []
    current_block = np.empty((BLOCK, n_samples), dtype=np.uint8)
    block_idx = 0

    proc = subprocess.Popen(
        ["bcftools", "query", "-f", r"%POS\t%REF\t%ALT[\t%GT]\n", str(vcf)],
        stdout=subprocess.PIPE, bufsize=4194304,
    )

    matched = 0
    total = 0
    start = time.monotonic()
    last_report = start

    for raw_line in proc.stdout:
        total += 1
        tab1 = raw_line.index(b'\t')
        pos = int(raw_line[:tab1])
        if pos not in pos_lookup:
            now = time.monotonic()
            if now - last_report > 15:
                rate = total / (now - start)
                print(f"  chr{chrom}: {total:,} scanned, {matched:,} matched "
                      f"({rate:.0f}/s)...", flush=True)
                last_report = now
            continue

        line = raw_line.decode("ascii", errors="replace")
        tab2 = line.index('\t', tab1 + 1)
        tab3 = line.index('\t', tab2 + 1)
        ref = line[tab1+1:tab2]
        alt = line[tab2+1:tab3]

        if ',' in alt:
            continue

        ak = compute_allele_key(ref, alt)
        if ak not in pos_lookup[pos]:
            continue

        matched += 1
        col_pos.append(pos)
        col_ak.append(ak)

        greatest = max(ref, alt)
        is_alt_greatest = (alt == greatest)
        gt_data = line[tab3+1:].rstrip('\n')
        si = 0
        gi = 0
        gt_len = len(gt_data)
        row = current_block[block_idx]

        while si < n_samples and gi < gt_len:
            c0 = gt_data[gi]
            if c0 == '.':
                row[si] = MISSING
                ni = gt_data.find('\t', gi)
                gi = ni + 1 if ni != -1 else gt_len
            else:
                a0 = 1 if c0 == '1' else 0
                a1 = 1 if gt_data[gi+2] == '1' else 0
                alt_count = a0 + a1
                row[si] = alt_count if is_alt_greatest else 2 - alt_count
                gi += 4
            si += 1
        while si < n_samples:
            row[si] = MISSING
            si += 1

        block_idx += 1
        if block_idx == BLOCK:
            dosage_blocks.append(current_block[:block_idx].copy())
            current_block = np.empty((BLOCK, n_samples), dtype=np.uint8)
            block_idx = 0

        now = time.monotonic()
        if now - last_report > 15:
            rate = total / (now - start)
            print(f"  chr{chrom}: {total:,} scanned, {matched:,} matched "
                  f"({rate:.0f}/s)...", flush=True)
            last_report = now

    proc.wait()
    elapsed = time.monotonic() - start

    if not col_pos:
        print(f"  chr{chrom}: 0 matches from {total:,} variants ({elapsed:.0f}s)")
        return None

    if block_idx > 0:
        dosage_blocks.append(current_block[:block_idx].copy())

    dosage_matrix = np.vstack(dosage_blocks)
    del dosage_blocks, current_block
    n_variants = dosage_matrix.shape[0]

    print(f"  chr{chrom}: {n_variants:,} matched from {total:,} ({elapsed:.0f}s), "
          f"writing parquet...", end="", flush=True)
    write_start = time.monotonic()

    arrays = [
        pa.array([chrom] * n_variants, type=pa.uint8()),
        pa.array(col_pos, type=pa.int32()),
        pa.array(col_ak, type=pa.int64()),
    ]
    names = ["chr", "pos", "allele_key"]
    for i in range(n_samples):
        arrays.append(pa.array(dosage_matrix[:, i], type=pa.uint8()))
        names.append(f"s{i}")

    table = pa.table(arrays, names=names)
    del arrays, dosage_matrix
    tmp_path = out_path.with_suffix(".parquet.tmp")
    pq.write_table(table, str(tmp_path), compression="zstd")
    del table
    tmp_path.rename(out_path)

    write_elapsed = time.monotonic() - write_start
    size_mb = out_path.stat().st_size / 1048576
    print(f" {size_mb:.1f} MB ({write_elapsed:.0f}s)", flush=True)
    return out_path


def extract_all_genotypes(chroms):
    print(f"\n🧬 Phase 2: Extract genotypes at pack positions\n")
    EXTRACT_DIR.mkdir(parents=True, exist_ok=True)
    sample_names = get_sample_names(chroms[0])
    print(f"  Samples: {len(sample_names):,}\n")
    for c in chroms:
        extract_chromosome(c, sample_names)
    print()


# ── Phase 3: Score one chromosome at a time using .asili per-chr parquets ───

def load_chr_dosage(chrom, n_samples):
    """Load one chromosome's extracted genotypes as uint8 dosage matrix.

    First call converts parquet → .npy for fast mmap access on subsequent runs.
    Uses np.memmap to avoid loading the full matrix into RAM — the OS pages
    in only the rows actually accessed during scoring.

    Returns:
      lookup: dict (pos, allele_key) → row index
      dosage: numpy uint8 (n_variants, n_samples) — memmap or array
      fd: file descriptor for the npy file (for fadvise), or None
    """
    parquet_path = EXTRACT_DIR / f"chr{chrom}.parquet"
    npy_path = EXTRACT_DIR / f"chr{chrom}_dosage.npy"
    keys_path = EXTRACT_DIR / f"chr{chrom}_keys.npz"

    if not parquet_path.exists():
        return None, None

    # Convert parquet → npy + keys on first access
    if not npy_path.exists():
        print(f" converting to npy...", end="", flush=True)
        keys = pq.read_table(parquet_path, columns=["pos", "allele_key"])
        pos_arr = keys.column("pos").to_numpy()
        ak_arr = keys.column("allele_key").to_numpy()
        n_variants = len(pos_arr)
        np.savez(str(keys_path), pos=pos_arr, ak=ak_arr)
        del keys, pos_arr, ak_arr

        # Write dosage as flat npy — read parquet columns in chunks
        dosage = np.empty((n_variants, n_samples), dtype=np.uint8)
        n_chunks = (n_samples + COL_CHUNK - 1) // COL_CHUNK
        for ci, start in enumerate(range(0, n_samples, COL_CHUNK)):
            end = min(start + COL_CHUNK, n_samples)
            cols = [f"s{i}" for i in range(start, end)]
            chunk = pq.read_table(parquet_path, columns=cols)
            for j, col_name in enumerate(cols):
                dosage[:, start + j] = chunk.column(col_name).to_numpy()
            del chunk
            gc.collect()
            if (ci + 1) % 4 == 0 or ci == n_chunks - 1:
                print(f" {end}/{n_samples}", end="", flush=True)

        tmp = npy_path.with_suffix(".tmp")
        np.save(str(tmp), dosage)
        Path(str(tmp) + ".npy").rename(npy_path)
        del dosage
        gc.collect()
        print(f" saved", end="", flush=True)

    # Load keys and build lookup
    print(f" building lookup...", end="", flush=True)
    kd = np.load(str(keys_path))
    pos_arr = kd["pos"]
    ak_arr = kd["ak"]
    n_variants = len(pos_arr)
    lookup = {}
    for i in range(n_variants):
        lookup[(int(pos_arr[i]), int(ak_arr[i]))] = i
    del kd, pos_arr, ak_arr

    # Memory-map the dosage — OS pages in only what's accessed
    dosage = np.load(str(npy_path), mmap_mode="r")

    # Open fd for posix_fadvise to release pages
    fd = os.open(str(npy_path), os.O_RDONLY)

    return lookup, dosage, fd



def get_manifest_trait_ids():
    """Get trait IDs from trait_manifest.json to limit to built traits."""
    manifest_path = ROOT / "data_out" / "trait_manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        traits = manifest.get("traits", {})
        if isinstance(traits, dict):
            return set(traits.keys())
    return None


def get_asili_files():
    """Get .asili files filtered to manifest traits if available."""
    all_files = sorted(ASILI_DIR.glob("*.asili"))
    trait_ids = get_manifest_trait_ids()
    if trait_ids:
        filtered = [f for f in all_files if f.stem.replace("_hg38", "") in trait_ids]
        return filtered
    return all_files


def read_chr_from_asili(asili_path, chrom):
    """Read a single chr parquet from an .asili tar → Arrow table.

    Returns None if the chromosome isn't in the archive.
    Memory: only the tiny per-chr parquet (~KB to ~MB).
    """
    target = f"chr{chrom}.parquet"
    try:
        with tarfile.open(asili_path) as tf:
            f = tf.extractfile(tf.getmember(target))
            if f is None:
                return None
            return pq.read_table(io.BytesIO(f.read()))
    except (KeyError, FileNotFoundError):
        return None


def save_chr_scores(chrom, chr_pgs_scores):
    """Save per-PGS score arrays for one chromosome to disk."""
    SCORE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out = SCORE_CACHE_DIR / f"chr{chrom}.npz"
    np.savez_compressed(str(out), **{k: v for k, v in chr_pgs_scores.items()})
    size_mb = out.stat().st_size / 1048576
    print(f"  Saved chr{chrom} scores: {len(chr_pgs_scores)} PGS ({size_mb:.1f} MB)",
          flush=True)


def save_chr_matches(chrom, chr_pgs_matches):
    """Save per-PGS matched variant data as individual numpy files.

    Layout: MATCH_CACHE_DIR/chr{N}/{pgs_id}.npz
    Each npz contains: rows (int32), weights (float64), orients (bool)
    Also writes an index file with variant counts per PGS.
    """
    chr_dir = MATCH_CACHE_DIR / f"chr{chrom}"
    chr_dir.mkdir(parents=True, exist_ok=True)
    index = {}  # pgs_id → variant count
    for pgs_id, data in chr_pgs_matches.items():
        n = len(data["rows"])
        np.savez(
            str(chr_dir / f"{pgs_id}.npz"),
            rows=np.array(data["rows"], dtype=np.int32),
            weights=np.array(data["weights"], dtype=np.float64),
            orients=np.array(data["orients"], dtype=np.bool_),
        )
        index[pgs_id] = n
    # Write index for fast counting without opening every npz
    (chr_dir / "_index.json").write_text(json.dumps(index))


def load_chr_match_for_pgs(chrom, pgs_id):
    """Load match data for a single PGS on one chromosome."""
    p = MATCH_CACHE_DIR / f"chr{chrom}" / f"{pgs_id}.npz"
    if not p.exists():
        return None
    d = np.load(str(p))
    return d["rows"], d["weights"], d["orients"]


def get_chr_match_pgs_ids(chrom):
    """Get list of PGS IDs that have match data for this chromosome."""
    chr_dir = MATCH_CACHE_DIR / f"chr{chrom}"
    if not chr_dir.exists():
        return []
    return [f.stem for f in chr_dir.glob("*.npz")]


def load_chr_scores(chrom):
    """Load cached per-PGS score arrays for one chromosome."""
    p = SCORE_CACHE_DIR / f"chr{chrom}.npz"
    if not p.exists():
        return None
    data = np.load(str(p))
    return {k: data[k] for k in data.files}


def score_all_pgs(chroms):
    """Phase 3: For each chromosome:
      1. Load dosage as uint8 (~1-5 GB)
      2. For each .asili file, read that chr's parquet (tiny, ~KB-MB)
      3. Match variants, score via numpy matmul
      4. Accumulate per-PGS scores, free dosage

    Uses .asili per-chr parquets instead of monolithic packs to avoid
    loading multi-GB pack files that can't be efficiently filtered.
    Peak memory ≈ one chromosome's dosage matrix.
    """
    print(f"📊 Phase 3: Score individuals\n")

    sample_names = get_sample_names(chroms[0])
    n_samples = len(sample_names)

    asili_files = get_asili_files()
    if not asili_files:
        print(f"  ✗ No .asili files found in {ASILI_DIR}")
        return {}
    print(f"  {len(asili_files)} trait packs, {n_samples} samples\n")

    for ci, chrom in enumerate(chroms, 1):
        chr_start = time.monotonic()
        print(f"  ── chr{chrom} ({ci}/{len(chroms)}) ──", flush=True)

        # Check for cached scores from a previous run
        cached = load_chr_scores(chrom)
        if cached is not None:
            print(f"  ✓ cached ({len(cached)} PGS)\n", flush=True)
            del cached
            continue

        print(f"  Loading dosage...", end="", flush=True)
        load_start = time.monotonic()
        lookup, dosage, dosage_fd = load_chr_dosage(chrom, n_samples)
        if lookup is None:
            print(f" no data, skipping")
            continue
        load_elapsed = time.monotonic() - load_start
        mem_gb = dosage.nbytes / (1024**3)
        print(f" {len(lookup):,} variants, {mem_gb:.1f} GB mmap ({load_elapsed:.0f}s)",
              flush=True)

        chr_matched_total = 0
        chr_pgs_scored = 0
        chr_pgs_scores = {}  # per-chr accumulator for cache
        # Only accumulate match data if not already cached
        matches_exist = (MATCH_CACHE_DIR / f"chr{chrom}").exists() and \
            list((MATCH_CACHE_DIR / f"chr{chrom}").glob("*.npz"))
        chr_pgs_matches = None if matches_exist else {}

        for ai, asili_path in enumerate(asili_files):
            pack_table = read_chr_from_asili(asili_path, chrom)
            if pack_table is None or len(pack_table) == 0:
                continue

            trait_name = asili_path.stem.replace("_hg38", "")
            pack_rows = len(pack_table)

            pgs_col = pack_table.column("pgs_id").to_pylist()
            weight_col = pack_table.column("effect_weight").to_numpy().astype(np.float64)
            pos_col = pack_table.column("pos").to_numpy()
            ak_col = pack_table.column("allele_key").to_numpy()
            vid_col = pack_table.column("variant_id").to_pylist()
            ea_col = pack_table.column("effect_allele").to_pylist()
            del pack_table

            trait_pgs_scored = 0

            pgs_groups = {}
            for i, pid in enumerate(pgs_col):
                pgs_groups.setdefault(pid, []).append(i)

            for pgs_id, indices in pgs_groups.items():
                geno_rows = []
                w_list = []
                o_list = []

                for idx in indices:
                    key = (int(pos_col[idx]), int(ak_col[idx]))
                    row_idx = lookup.get(key)
                    if row_idx is not None:
                        geno_rows.append(row_idx)
                        w_list.append(weight_col[idx])
                        parts = vid_col[idx].split(":")
                        o_list.append(ea_col[idx] == max(parts[2], parts[3]))

                if not geno_rows:
                    continue

                chr_matched_total += len(geno_rows)

                geno_idx = np.array(geno_rows)
                sub = dosage[geno_idx].astype(np.int16)  # small copy from mmap

                orient_arr = np.array(o_list)
                flip = ~orient_arr
                if flip.any():
                    sub[flip] = 2 - sub[flip]

                # Zero out missing (255 → 0)
                sub[sub == MISSING] = 0

                w = np.array(w_list, dtype=np.float64)
                scores = w @ sub
                del sub

                if pgs_id in chr_pgs_scores:
                    chr_pgs_scores[pgs_id] += scores
                else:
                    chr_pgs_scores[pgs_id] = scores.copy()

                # Save match data for tiered rescoring (if not already cached)
                if chr_pgs_matches is not None:
                    if pgs_id not in chr_pgs_matches:
                        chr_pgs_matches[pgs_id] = {"rows": [], "weights": [], "orients": []}
                    chr_pgs_matches[pgs_id]["rows"].extend(geno_rows)
                    chr_pgs_matches[pgs_id]["weights"].extend(w_list)
                    chr_pgs_matches[pgs_id]["orients"].extend(o_list)

                chr_pgs_scored += 1
                trait_pgs_scored += 1

            del pgs_col, weight_col, pos_col, ak_col, vid_col, ea_col, pgs_groups

            print(f"    [{ai+1}/{len(asili_files)}] {trait_name}: "
                  f"{pack_rows:,} rows, {trait_pgs_scored} PGS "
                  f"(RSS {rss_gb():.1f}GB)", flush=True)
            gc.collect()
            # Every 10 traits, advise kernel to drop file pages to cap RSS
            if (ai + 1) % 10 == 0 and rss_gb() > 5.0:
                try:
                    os.posix_fadvise(dosage_fd, 0, 0, os.POSIX_FADV_DONTNEED)
                except (OSError, AttributeError):
                    pass

        chr_elapsed = time.monotonic() - chr_start
        print(f"  chr{chrom}: {chr_pgs_scored} PGS scored, "
              f"{chr_matched_total:,} variant×PGS matches ({chr_elapsed:.0f}s)\n",
              flush=True)

        save_chr_scores(chrom, chr_pgs_scores)
        if chr_pgs_matches is not None:
            save_chr_matches(chrom, chr_pgs_matches)
        os.close(dosage_fd)
        del lookup, dosage, chr_pgs_scores, chr_pgs_matches
        gc.collect()

    # Sum per-chr scores from disk (memory-efficient: one chr at a time)
    print(f"  Summing scores from {len(chroms)} chromosomes...", flush=True)
    pgs_scores = {}
    for chrom in chroms:
        cached = load_chr_scores(chrom)
        if cached is None:
            continue
        for pgs_id, scores in cached.items():
            if pgs_id in pgs_scores:
                pgs_scores[pgs_id] += scores
            else:
                pgs_scores[pgs_id] = scores.copy()
        del cached
    print(f"  {len(pgs_scores)} PGS with scores\n", flush=True)

    return pgs_scores


def build_match_data(chroms):
    """Build match data cache from .asili files + extracted key lookups.

    Used when Phase 3 scores are cached but match data wasn't saved
    (e.g. first run before tiered scoring was added).
    """
    # Check if match data already exists (new per-PGS npz format)
    if all((MATCH_CACHE_DIR / f"chr{c}").exists() for c in chroms):
        return

    print(f"\n🔗 Building match data for tiered scoring...\n")
    asili_files = get_asili_files()
    if not asili_files:
        return

    for chrom in chroms:
        chr_dir = MATCH_CACHE_DIR / f"chr{chrom}"
        if chr_dir.exists() and list(chr_dir.glob("*.npz")):
            print(f"  chr{chrom}: ✓ cached", flush=True)
            continue

        keys_path = EXTRACT_DIR / f"chr{chrom}_keys.npz"
        if not keys_path.exists():
            continue

        # Build lookup from keys
        kd = np.load(str(keys_path))
        pos_arr = kd["pos"]
        ak_arr = kd["ak"]
        lookup = {}
        for i in range(len(pos_arr)):
            lookup[(int(pos_arr[i]), int(ak_arr[i]))] = i
        del kd, pos_arr, ak_arr

        chr_pgs_matches = {}
        for asili_path in asili_files:
            pack_table = read_chr_from_asili(asili_path, chrom)
            if pack_table is None or len(pack_table) == 0:
                continue

            pgs_col = pack_table.column("pgs_id").to_pylist()
            weight_col = pack_table.column("effect_weight").to_numpy().astype(np.float64)
            pos_col = pack_table.column("pos").to_numpy()
            ak_col = pack_table.column("allele_key").to_numpy()
            vid_col = pack_table.column("variant_id").to_pylist()
            ea_col = pack_table.column("effect_allele").to_pylist()
            del pack_table

            pgs_groups = {}
            for i, pid in enumerate(pgs_col):
                pgs_groups.setdefault(pid, []).append(i)

            for pgs_id, indices in pgs_groups.items():
                for idx in indices:
                    key = (int(pos_col[idx]), int(ak_col[idx]))
                    row_idx = lookup.get(key)
                    if row_idx is not None:
                        parts = vid_col[idx].split(":")
                        orient = ea_col[idx] == max(parts[2], parts[3])
                        if pgs_id not in chr_pgs_matches:
                            chr_pgs_matches[pgs_id] = {"rows": [], "weights": [], "orients": []}
                        chr_pgs_matches[pgs_id]["rows"].append(row_idx)
                        chr_pgs_matches[pgs_id]["weights"].append(float(weight_col[idx]))
                        chr_pgs_matches[pgs_id]["orients"].append(bool(orient))

            del pgs_col, weight_col, pos_col, ak_col, vid_col, ea_col, pgs_groups

        save_chr_matches(chrom, chr_pgs_matches)
        print(f"  chr{chrom}: {len(chr_pgs_matches)} PGS", flush=True)
        del lookup, chr_pgs_matches
        gc.collect()

    print()


def compute_norms(pgs_scores):
    results = {}
    for pgs_id, scores in pgs_scores.items():
        # Center scores to match browser behavior (browser subtracts
        # expected_dosage per variant; for the reference panel the population
        # mean equals expected value, so centering = subtracting mean).
        scores = scores - np.mean(scores)
        mean = float(np.nanmean(scores))
        sd = float(np.nanstd(scores))
        if sd > 0:
            results[pgs_id] = {
                "mean": round(mean, 8),
                "sd": round(sd, 8),
                "n_individuals": len(scores),
            }
    return results


def load_array_positions():
    """Load real consumer array positions from server-data/variants/*.json.
    Union of all available user files to get maximum position coverage."""
    positions = set()  # (chr, pos) tuples
    variants_dir = ROOT / "server-data" / "variants"
    if not variants_dir.exists():
        return positions
    for f in variants_dir.glob("*.json"):
        data = json.loads(f.read_text())
        for v in data.get("variants", []):
            try:
                chr_val = int(v["chromosome"])
                positions.add((chr_val, int(v["position"])))
            except (ValueError, KeyError):
                continue
    return positions


def compute_tiered_norms(chroms):
    """Phase 4: Rescore with random subsampling to produce tiered norms.

    For each PGS, subsample variants at 13% (raw) and 60% (imputed) coverage,
    averaged over TIER_ITERATIONS iterations for stability.

    Memory-efficient: loads match data per-PGS (tiny npz files), processes
    one PGS at a time with mmap'd dosage.
    """
    print(f"\n📊 Phase 4: Compute tiered norms (subsampling)\n")

    sample_names = get_sample_names(chroms[0])
    n_samples = len(sample_names)

    # Collect all PGS IDs that have match data
    all_pgs_ids = set()
    for chrom in chroms:
        all_pgs_ids.update(get_chr_match_pgs_ids(chrom))

    pgs_ids = sorted(all_pgs_ids)
    print(f"  {len(pgs_ids)} PGS with match data\n")

    if not pgs_ids:
        return {}

    tiered_results = {}

    # Process one chromosome at a time to avoid mmap thrashing.
    # For each chr, load dosage once, then score all PGS that have
    # variants on that chr. Accumulate partial scores per PGS.
    #
    # First, determine total variant counts per PGS from index files.
    pgs_variant_counts = {}  # pgs_id → total
    pgs_chr_counts = {}  # pgs_id → {chrom: count}
    for chrom in chroms:
        chr_dir = MATCH_CACHE_DIR / f"chr{chrom}"
        idx_path = chr_dir / "_index.json" if chr_dir.exists() else None
        if not idx_path or not idx_path.exists():
            # Fallback: build index from npz files
            if chr_dir and chr_dir.exists():
                index = {}
                for npz_file in chr_dir.glob("*.npz"):
                    pgs_id = npz_file.stem
                    n = np.load(str(npz_file))["rows"].shape[0]
                    index[pgs_id] = n
                idx_path = chr_dir / "_index.json"
                idx_path.write_text(json.dumps(index))
                print(f"    Built index for chr{chrom}: {len(index)} PGS", flush=True)
            else:
                continue
        else:
            index = json.loads(idx_path.read_text())
        for pgs_id, n in index.items():
            pgs_variant_counts[pgs_id] = pgs_variant_counts.get(pgs_id, 0) + n
            pgs_chr_counts.setdefault(pgs_id, {})[chrom] = n
        del index

    pgs_ids = sorted(pid for pid, cnt in pgs_variant_counts.items() if cnt >= 5)
    print(f"  {len(pgs_ids)} PGS with ≥5 variants\n")
    if not pgs_ids:
        return {}

    # Allocate score accumulators: scores[pgs_id][tier_name][iter] = float64 array
    # Only allocate for tiers where subsampling is needed
    scores = {}
    pgs_tiers_k = {}  # pgs_id → {tier_name: k}
    for pgs_id in pgs_ids:
        n_vars = pgs_variant_counts[pgs_id]
        tiers_k = {}
        for tier_name, coverage in TIER_COVERAGES.items():
            k = max(1, int(round(n_vars * coverage)))
            if k < n_vars:
                tiers_k[tier_name] = k
        if tiers_k:
            pgs_tiers_k[pgs_id] = tiers_k
            scores[pgs_id] = {}
            for tier_name in tiers_k:
                n_iters = RAW_TIER_ITERATIONS if tier_name == "raw" else TIER_ITERATIONS
                scores[pgs_id][tier_name] = [
                    np.zeros(n_samples, dtype=np.float64)
                    for _ in range(n_iters)
                ]

    print(f"  {len(scores)} PGS need tiered scoring\n")

    # Load real array positions for the raw tier mask
    array_positions = load_array_positions()
    print(f"  Array positions loaded: {len(array_positions):,}\n")

    # Load per-chr position arrays (row index → genomic position)
    chr_row_positions = {}  # chrom → numpy array of positions
    for chrom in chroms:
        keys_path = EXTRACT_DIR / f"chr{chrom}_keys.npz"
        if keys_path.exists():
            kd = np.load(str(keys_path))
            chr_row_positions[chrom] = kd["pos"]
            del kd

    # Build per-chr sets of row indices at array positions for fast lookup
    chr_array_rows = {}  # chrom → set of row indices at array positions
    for chrom, pos_arr in chr_row_positions.items():
        array_rows = set()
        for i, pos in enumerate(pos_arr):
            if (chrom, int(pos)) in array_positions:
                array_rows.add(i)
        chr_array_rows[chrom] = array_rows
    del array_positions
    print(f"  Array row masks built for {len(chr_array_rows)} chromosomes\n")

    # Process in batches to cap mask memory.
    # Each batch: generate masks, process all 22 chr, then free masks.
    BATCH_SIZE = 50
    batch_pgs_list = [list(scores.keys())[i:i+BATCH_SIZE]
                      for i in range(0, len(scores), BATCH_SIZE)]
    n_batches = len(batch_pgs_list)

    # Process one chromosome at a time within each batch
    for batch_idx, batch_pgs in enumerate(batch_pgs_list):
        batch_start_t = time.monotonic()
        print(f"    Batch {batch_idx+1}/{n_batches} ({len(batch_pgs)} PGS): masks...",
              end="", flush=True)

        # Generate masks for this batch only
        # chr_masks[pgs_id][tier][chrom] = list of local index arrays per iter
        chr_masks = {}
        for pgs_id in batch_pgs:
            n_total = pgs_variant_counts[pgs_id]
            chr_masks[pgs_id] = {}
            # Build chr offsets for this PGS
            offsets = []
            running = 0
            for c in chroms:
                n = pgs_chr_counts.get(pgs_id, {}).get(c, 0)
                if n > 0:
                    offsets.append((c, running, n))
                running += n

            for tier_name, k in pgs_tiers_k[pgs_id].items():
                chr_masks[pgs_id][tier_name] = {}

                if tier_name == "raw":
                    # Deterministic mask: keep only variants at array positions
                    # Build per-chr local indices from match data
                    for chrom, offset, count in offsets:
                        npz_path = MATCH_CACHE_DIR / f"chr{chrom}" / f"{pgs_id}.npz"
                        if not npz_path.exists():
                            chr_masks[pgs_id][tier_name][chrom] = [None]
                            continue
                        d = np.load(str(npz_path))
                        rows = d["rows"]
                        arr_rows = chr_array_rows.get(chrom, set())
                        # Find which of this PGS's rows are at array positions
                        local = np.array([i for i, r in enumerate(rows)
                                          if int(r) in arr_rows], dtype=np.int32)
                        if len(local) > 0:
                            chr_masks[pgs_id][tier_name][chrom] = [local]
                        else:
                            chr_masks[pgs_id][tier_name][chrom] = [None]
                        del d
                else:
                    # Random subsampling for imputed tier
                    iters = min(TIER_ITERATIONS, max(3, 500_000 // max(n_total, 1)))
                    # Reallocate if fewer iterations needed
                    if iters != TIER_ITERATIONS:
                        scores[pgs_id][tier_name] = [
                            np.zeros(n_samples, dtype=np.float64)
                            for _ in range(iters)
                        ]
                    for it_idx in range(iters):
                        iter_rng = np.random.default_rng((hash(pgs_id) & 0xFFFFFFFF, it_idx, 42))
                        mask = np.sort(iter_rng.choice(n_total, size=k, replace=False))
                        for chrom, offset, count in offsets:
                            left = np.searchsorted(mask, offset, side="left")
                            right = np.searchsorted(mask, offset + count, side="left")
                            if left < right:
                                local = (mask[left:right] - offset).astype(np.int32)
                                chr_masks[pgs_id][tier_name].setdefault(chrom, []).append(local)
                            else:
                                chr_masks[pgs_id][tier_name].setdefault(chrom, []).append(None)
                        del mask

            print(f" scoring...", end="", flush=True)

        # Score this batch across all chromosomes
        for ci, chrom in enumerate(chroms, 1):
            npy_path = EXTRACT_DIR / f"chr{chrom}_dosage.npy"
            chr_dir = MATCH_CACHE_DIR / f"chr{chrom}"
            if not npy_path.exists() or not chr_dir.exists():
                continue

            dosage = np.load(str(npy_path), mmap_mode="r")

            for pgs_id in batch_pgs:
                npz_path = chr_dir / f"{pgs_id}.npz"
                if not npz_path.exists():
                    continue

                d = np.load(str(npz_path))
                rows = d["rows"]
                weights = d["weights"]
                orients = d["orients"]

                for tier_name in pgs_tiers_k[pgs_id]:
                    tier_chr_data = chr_masks[pgs_id][tier_name].get(chrom)
                    if tier_chr_data is None:
                        continue
                    for it_idx, local in enumerate(tier_chr_data):
                        if local is None:
                            continue
                        r = rows[local]
                        w = weights[local]
                        o = orients[local]

                        sub = dosage[r].astype(np.int16)
                        flip = ~o
                        if flip.any():
                            sub[flip] = 2 - sub[flip]
                        sub[sub == MISSING] = 0
                        scores[pgs_id][tier_name][it_idx] += w @ sub
                        del sub

                del d

            del dosage
            gc.collect()

        del chr_masks
        gc.collect()

        batch_elapsed = time.monotonic() - batch_start_t
        print(f" done ({batch_elapsed:.0f}s, RSS {rss_gb():.1f}GB)", flush=True)

    # Compute final mean/SD from accumulated scores
    for pgs_id in pgs_ids:
        if pgs_id not in scores:
            continue
        tiers = {}
        for tier_name, iter_scores in scores[pgs_id].items():
            # Center: browser subtracts expected_dosage, so mean ≈ 0.
            # SD is invariant to centering, so just use std directly.
            iter_sds = [float(np.std(s)) for s in iter_scores]
            avg_sd = np.mean(iter_sds)
            if avg_sd > 0:
                tiers[tier_name] = {
                    "m": 0.0,
                    "s": round(avg_sd, 8),
                }
        if tiers:
            tiered_results[pgs_id] = tiers

    del scores, pgs_tiers_k, chr_row_positions, chr_array_rows
    gc.collect()
    print(f"\n  ✓ Tiered norms computed for {len(tiered_results)} PGS\n")
    return tiered_results


# ── Output ──────────────────────────────────────────────────────────────────

def update_manifest(results):
    if not MANIFEST_DB.exists():
        print(f"  ⚠ Manifest DB not found: {MANIFEST_DB}")
        return
    print(f"\n📥 Updating manifest DB with {len(results)} empirical norms...",
          flush=True)
    con = duckdb.connect(str(MANIFEST_DB))
    for pgs_id, data in results.items():
        con.execute(
            "UPDATE pgs_scores SET norm_mean = ?, norm_sd = ?, "
            "last_updated = CURRENT_TIMESTAMP WHERE pgs_id = ?",
            [data["mean"], data["sd"], pgs_id],
        )
    con.close()
    print(f"  ✓ Updated {len(results):,} PGS in manifest\n")


def update_norm_params_json(results, tiered_results=None):
    existing = {}
    if OUTPUT_JSON.exists():
        try:
            existing = json.loads(OUTPUT_JSON.read_text())
        except Exception:
            pass
    for pgs_id, data in results.items():
        prev = existing.get(pgs_id, {})
        entry = {
            "m": data["mean"],
            "s": data["sd"],
            "n": prev.get("n", 0),
            **({"d": prev["d"]} if "d" in prev else {}),
            **({"ancestry": prev["ancestry"]} if "ancestry" in prev else {}),
        }
        # Add tiered norms if available
        if tiered_results and pgs_id in tiered_results:
            entry["tiers"] = tiered_results[pgs_id]
        elif prev.get("tiers"):
            entry["tiers"] = prev["tiers"]
        existing[pgs_id] = entry
    OUTPUT_JSON.write_text(json.dumps(existing))
    size_kb = OUTPUT_JSON.stat().st_size // 1024
    print(f"  ✓ Wrote {len(existing)} PGS to {OUTPUT_JSON} ({size_kb} KB)\n")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    if "--reset" in args:
        print("🔄 Resetting extracted genotypes...")
        if EXTRACT_DIR.exists():
            shutil.rmtree(EXTRACT_DIR)
            print(f"  ✓ Removed {EXTRACT_DIR}")
        else:
            print("  Nothing to remove.")
        return

    chroms = CHROMS
    for i, a in enumerate(args):
        if a == "--chr" and i + 1 < len(args):
            chroms = [int(args[i + 1])]

    total_start = time.monotonic()

    print("=" * 60)
    print("  Empirical PGS Normalization (NYGC 30x × 1000 Genomes)")
    print("=" * 60)
    print(f"  VCF dir:     {NYGC_DIR}")
    print(f"  Extract dir: {EXTRACT_DIR}")
    print(f"  Packs:       {PACKS_DIR}")
    if len(chroms) > 1:
        print(f"  Chromosomes: {chroms[0]}-{chroms[-1]}")
    else:
        print(f"  Chromosome:  {chroms[0]}")
    print(f"  DuckDB:      {DB_THREADS} threads, {DB_MEMORY} memory")
    print(f"  Temp:        {TMP_DIR}")

    if not ASILI_DIR.exists() or not list(ASILI_DIR.glob("*.asili")):
        print(f"\n✗ No .asili files in {ASILI_DIR}")
        print("  Run: pnpm etl local")
        sys.exit(1)

    if not ensure_nygc_vcfs(chroms):
        print("\n✗ Download failed. Re-run to resume.")
        sys.exit(1)

    extract_all_genotypes(chroms)

    pgs_scores = score_all_pgs(chroms)
    if not pgs_scores:
        print("\n✗ No scores computed.")
        sys.exit(1)

    results = compute_norms(pgs_scores)
    if not results:
        print("\n✗ All PGS had SD=0.")
        sys.exit(1)

    sds = [r["sd"] for r in results.values()]
    means = [r["mean"] for r in results.values()]
    print(f"\n  Results: {len(results)} PGS with empirical norms")
    print(f"    Mean range: [{min(means):.4f}, {max(means):.4f}]")
    print(f"    SD range:   [{min(sds):.6f}, {max(sds):.4f}]")
    zero_sd = len(pgs_scores) - len(results)
    if zero_sd:
        print(f"    Dropped:    {zero_sd} PGS with SD=0")

    # Phase 4: Build match data (if missing) then compute tiered norms
    build_match_data(chroms)
    tiered_results = compute_tiered_norms(chroms)

    update_manifest(results)
    update_norm_params_json(results, tiered_results)

    total_elapsed = time.monotonic() - total_start
    hours = int(total_elapsed // 3600)
    mins = int((total_elapsed % 3600) // 60)
    print(f"✅ Complete in {hours}h {mins}m — {len(results)} PGS with empirical norms")


if __name__ == "__main__":
    main()
