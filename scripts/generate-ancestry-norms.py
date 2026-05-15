#!/usr/bin/env python3
"""
Compute ancestry-specific PGS normalization parameters (mean/SD per population).

Two-phase approach to handle the large AF file without blowing memory:
  1. Extract unique chr:pos from all packs (small — fits in memory)
  2. Stream-filter the 78M-row AF file to only matching positions (cached)
  3. Load the filtered AF into DuckDB and join against packs (same as TOPMed refstats)

Usage:
  python3 scripts/generate-ancestry-norms.py <af_tsv> <packs_dir> <norm_params_json>
"""
import sys
import os
import json
import time
from pathlib import Path

import duckdb

POPULATIONS = ["afr", "amr", "asj", "eas", "fin", "mid", "nfe", "sas"]
POP_LABELS = {
    "afr": "AFR", "amr": "AMR", "asj": "ASJ", "eas": "EAS",
    "fin": "FIN", "mid": "MID", "nfe": "NFE", "sas": "SAS",
}


def filter_af_to_positions(af_tsv, packs_dir, filtered_tsv, tmp_dir):
    """Phase 1+2: Extract positions from packs, then stream-filter the AF file."""
    if Path(filtered_tsv).exists():
        count = sum(1 for _ in open(filtered_tsv)) - 1
        print(f"  ✓ Using cached filtered AF: {count:,} variants")
        return

    print("  Phase 1: Extracting unique positions from packs...")
    start = time.monotonic()

    con = duckdb.connect()
    con.execute(f"SET temp_directory='{tmp_dir}'")
    con.execute("SET memory_limit='2GB'")
    con.execute("SET threads TO 4")

    # Get unique chr:pos from all packs — this is small (millions, not tens of millions)
    positions = set()
    pack_files = sorted(Path(packs_dir).glob("*.parquet"))
    for pf in pack_files:
        rows = con.execute(f"SELECT DISTINCT chr, pos FROM read_parquet('{pf}')").fetchall()
        for chr_val, pos_val in rows:
            positions.add(f"{chr_val}:{pos_val}")

    con.close()
    elapsed = time.monotonic() - start
    print(f"  ✓ Found {len(positions):,} unique positions in {len(pack_files)} packs ({elapsed:.0f}s)")

    print(f"  Phase 2: Filtering {Path(af_tsv).stat().st_size / 1e9:.1f}GB AF file (streaming)...")
    start = time.monotonic()

    written = 0
    with open(af_tsv) as fin, open(filtered_tsv, "w") as fout:
        header = fin.readline()
        fout.write(header)

        for line in fin:
            # variant_id is chr:pos:ref:alt — extract chr:pos
            tab = line.index("\t")
            vid = line[:tab]
            parts = vid.split(":", 2)
            key = f"{parts[0]}:{parts[1]}"
            if key in positions:
                fout.write(line)
                written += 1

    elapsed = time.monotonic() - start
    size_mb = Path(filtered_tsv).stat().st_size / (1024 * 1024)
    print(f"  ✓ Filtered to {written:,} variants ({size_mb:.1f} MB) in {elapsed:.0f}s")


def compute_ancestry_norms(filtered_tsv, packs_dir, norm_params_json, tmp_dir):
    """Phase 3: Load filtered AF + join against packs (same pattern as TOPMed refstats)."""
    norm_params = json.load(open(norm_params_json))
    pgs_ids = set(norm_params.keys())

    print(f"\n  Phase 3: Computing ancestry norms for {len(pgs_ids)} PGS...")
    start = time.monotonic()

    con = duckdb.connect()
    con.execute(f"SET temp_directory='{tmp_dir}'")
    con.execute("SET memory_limit='8GB'")
    con.execute("SET threads TO 4")
    con.execute("SET preserve_insertion_order=false")

    # Detect available populations
    sample = con.execute(f"SELECT * FROM read_csv('{filtered_tsv}', sep='\t', header=true) LIMIT 1").description
    col_names = [c[0].lower() for c in sample]
    available_pops = [p for p in POPULATIONS if f"af_{p}" in col_names]
    print(f"  Populations: {', '.join(POP_LABELS[p] for p in available_pops)}")

    # Load filtered AF into a table with allele_key (same as TOPMed refstats pattern)
    con.execute(f"""
        CREATE TABLE ancestry_af AS
        SELECT
            variant_id,
            TRY_CAST(split_part(variant_id, ':', 1) AS TINYINT) AS chr,
            TRY_CAST(split_part(variant_id, ':', 2) AS INTEGER) AS pos,
            ('0x' || md5(
                LEAST(split_part(variant_id, ':', 3), split_part(variant_id, ':', 4))
                || ':' ||
                GREATEST(split_part(variant_id, ':', 3), split_part(variant_id, ':', 4))
            )[:15])::BIGINT AS allele_key,
            {', '.join(f'TRY_CAST(af_{p} AS DOUBLE) AS af_{p}' for p in available_pops)}
        FROM read_csv('{filtered_tsv}', sep='\t', header=true, all_varchar=true)
    """)

    af_count = con.execute("SELECT count(*) FROM ancestry_af").fetchone()[0]
    print(f"  ✓ Loaded {af_count:,} filtered ancestry AFs")

    con.execute("CREATE INDEX idx_anc ON ancestry_af(chr, pos, allele_key)")

    # Build per-population aggregation SQL
    # Orient expected dosage: AF = ALT allele frequency from the AF source.
    # Compare effect_allele against the AF source's ALT allele (col4 of a.variant_id),
    # NOT the pack's col4 — the pack may have swapped ref/alt ordering.
    #   effect_allele == AF ALT (a.variant_id col4): expected_dosage = 2 * AF
    #   effect_allele == AF REF (a.variant_id col3): expected_dosage = 2 * (1 - AF)
    # Variance is symmetric (orientation-independent)
    pop_agg = []
    for p in available_pops:
        pop_agg.append(f"""
            SUM(CASE WHEN a.af_{p} IS NOT NULL THEN
                p.effect_weight * CASE
                    WHEN p.effect_allele = split_part(a.variant_id, ':', 4)
                    THEN 2 * a.af_{p}
                    ELSE 2 * (1 - a.af_{p})
                END
            ELSE NULL END) AS mean_{p},
            SQRT(NULLIF(SUM(CASE WHEN a.af_{p} IS NOT NULL
                THEN p.effect_weight * p.effect_weight * 2 * a.af_{p} * (1 - a.af_{p}) ELSE NULL END), 0)) AS sd_{p},
            COUNT(a.af_{p}) AS found_{p}
        """)

    results = {}
    pack_files = sorted(Path(packs_dir).glob("*.parquet"))

    for i, pf in enumerate(pack_files, 1):
        pf_start = time.monotonic()
        pgs_filter = ",".join(f"'{p}'" for p in pgs_ids)

        try:
            rows = con.execute(f"""
                SELECT
                    p.pgs_id,
                    count(*) AS total_variants,
                    {', '.join(pop_agg)}
                FROM read_parquet('{pf}') p
                LEFT JOIN ancestry_af a ON p.chr = a.chr AND p.pos = a.pos AND p.allele_key = a.allele_key
                WHERE p.pgs_id IN (SELECT unnest(list_value({pgs_filter})))
                GROUP BY p.pgs_id
            """).fetchall()
        except Exception as e:
            if "Binder" not in str(type(e).__name__):
                raise
            rows = con.execute(f"""
                SELECT
                    p.pgs_id,
                    count(*) AS total_variants,
                    {', '.join(pop_agg)}
                FROM read_parquet('{pf}') p
                LEFT JOIN ancestry_af a ON p.chr = a.chr AND p.pos = a.pos
                    AND a.allele_key = ('0x' || md5(
                        LEAST(split_part(p.variant_id,':',3), split_part(p.variant_id,':',4))
                        || ':' ||
                        GREATEST(split_part(p.variant_id,':',3), split_part(p.variant_id,':',4))
                    )[:15])::BIGINT
                WHERE p.pgs_id IN (SELECT unnest(list_value({pgs_filter})))
                GROUP BY p.pgs_id
            """).fetchall()

        for row in rows:
            pgs_id = row[0]
            total = row[1]
            ancestry = {}
            col_idx = 2
            for p in available_pops:
                mean_val = row[col_idx]
                sd_val = row[col_idx + 1]
                found = row[col_idx + 2]
                col_idx += 3
                if mean_val is not None and sd_val is not None and found > 0:
                    coverage = found / total if total > 0 else 0
                    if coverage >= 0.05:
                        ancestry[POP_LABELS[p]] = {
                            "m": round(float(mean_val), 8),
                            "s": round(float(sd_val), 8)
                        }
            if ancestry:
                if pgs_id not in results or len(ancestry) > len(results[pgs_id]):
                    results[pgs_id] = ancestry

        elapsed_pf = time.monotonic() - pf_start
        print(f"  [{i}/{len(pack_files)}] {pf.stem}: {len(rows)} PGS ({elapsed_pf:.0f}s)")

    con.close()

    # Merge into norm params
    added = 0
    for pgs_id, ancestry in results.items():
        if pgs_id in norm_params:
            norm_params[pgs_id]["ancestry"] = ancestry
            added += 1

    with open(norm_params_json, "w") as f:
        json.dump(norm_params, f)

    elapsed = time.monotonic() - start
    size_kb = Path(norm_params_json).stat().st_size // 1024
    print(f"\n  ✓ Added ancestry norms to {added} PGS in {elapsed:.0f}s")
    print(f"    Output: {norm_params_json} ({size_kb} KB)\n")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python3 generate-ancestry-norms.py <af_tsv> <packs_dir> <norm_params_json>")
        print("\nThe AF TSV must have columns: variant_id, af_eur, af_afr, af_eas, af_sas, af_amr")
        sys.exit(1)

    af_tsv = sys.argv[1]
    packs_dir = sys.argv[2]
    norm_params_json = sys.argv[3]

    # Source .env if LARGE_TMP not already set
    if "LARGE_TMP" not in os.environ:
        env_path = Path(__file__).resolve().parent.parent / ".env"
        if env_path.exists():
            for line in open(env_path):
                if line.strip() and not line.startswith("#") and "=" in line:
                    k, v = line.strip().split("=", 1)
                    if k not in os.environ:
                        os.environ[k] = v

    tmp_dir = os.environ.get("LARGE_TMP", "/tmp")

    filtered_tsv = str(Path(tmp_dir) / "ancestry_af_filtered.tsv")

    print(f"\n🌍 Ancestry-specific PGS normalization")
    print(f"   AF source: {af_tsv}")
    print(f"   Packs: {packs_dir}")
    print(f"   Filtered cache: {filtered_tsv}")
    print(f"   Temp dir: {tmp_dir}\n")

    filter_af_to_positions(af_tsv, packs_dir, filtered_tsv, tmp_dir)
    compute_ancestry_norms(filtered_tsv, packs_dir, norm_params_json, tmp_dir)
