#!/usr/bin/env python3
"""
Calculate PGS normalization statistics (mean/SD) using TOPMed allele frequencies.

Theoretical distribution under Hardy-Weinberg equilibrium:
  E[PGS] = Σ(w_i * 2 * af_i)
  Var[PGS] = Σ(w_i² * 2 * af_i * (1 - af_i))
  SD = √Var

TOPMed provides AF for ~70M variants — far better coverage than gnomAD's
filtered sites file which only joins at ~4% for most PGS scores.
"""
import sys
import os
import json
import time
import subprocess
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import duckdb


def extract_topmed_af(panel_dir, output_tsv):
    """Extract chr:pos:ref:alt → AF from all TOPMed chromosomes into one TSV."""
    if Path(output_tsv).exists():
        count = sum(1 for _ in open(output_tsv))
        print(f"  ✓ Using cached AF file: {count:,} variants")
        return

    print("  Extracting allele frequencies from TOPMed panel...")
    start = time.monotonic()

    def _extract_chr(chrom):
        vcf = f"{panel_dir}/chr{chrom}.topmed.vcf.gz"
        if not Path(vcf).exists():
            return b""
        result = subprocess.run(
            ["bcftools", "query", "-f", "%CHROM:%POS:%REF:%ALT\t%AF\n", vcf],
            capture_output=True, check=True
        )
        return result.stdout

    chunks = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for data in pool.map(_extract_chr, range(1, 23)):
            chunks.append(data)

    with open(output_tsv, "wb") as f:
        for chunk in chunks:
            f.write(chunk)

    count = sum(1 for _ in open(output_tsv))
    elapsed = time.monotonic() - start
    print(f"  ✓ Extracted {count:,} variants in {elapsed:.0f}s")


def compute_normalization(packs_dir, af_tsv, output_json, pgs_list_file):
    """Compute mean/SD for each PGS by joining pack weights against TOPMed AF.

    Processes one pack file at a time to avoid spilling hundreds of GB to disk.
    """
    with open(pgs_list_file) as f:
        pgs_to_process = set(json.load(f))

    if not pgs_to_process:
        print("No PGS to process.")
        return

    print(f"\n  Computing normalization for {len(pgs_to_process)} PGS scores...")
    start = time.monotonic()

    tmp_dir = os.environ.get("LARGE_TMP", "/tmp")

    con = duckdb.connect()
    con.execute(f"SET temp_directory='{tmp_dir}'")
    con.execute("SET threads TO 8")

    # Load TOPMed AF as a table — strip chr prefix, compute allele_key for allele-aware joins
    con.execute(f"""
        CREATE TABLE topmed_af AS
        SELECT
            regexp_replace(column0, '^chr', '') AS variant_id,
            TRY_CAST(column1 AS DOUBLE) AS af,
            TRY_CAST(split_part(regexp_replace(column0, '^chr', ''), ':', 1) AS TINYINT) AS chr,
            TRY_CAST(split_part(regexp_replace(column0, '^chr', ''), ':', 2) AS INTEGER) AS pos,
            ('0x' || md5(
                LEAST(split_part(regexp_replace(column0, '^chr', ''), ':', 3), split_part(regexp_replace(column0, '^chr', ''), ':', 4))
                || ':' ||
                GREATEST(split_part(regexp_replace(column0, '^chr', ''), ':', 3), split_part(regexp_replace(column0, '^chr', ''), ':', 4))
            )[:15])::BIGINT AS allele_key
        FROM read_csv('{af_tsv}', sep='\t', header=false, all_varchar=true)
        WHERE TRY_CAST(column1 AS DOUBLE) IS NOT NULL
    """)
    af_count = con.execute("SELECT count(*) FROM topmed_af").fetchone()[0]
    print(f"  ✓ Loaded {af_count:,} TOPMed allele frequencies")

    con.execute("CREATE INDEX idx_af_chr_pos ON topmed_af(chr, pos, allele_key)")

    pack_files = sorted(Path(packs_dir).glob("*.parquet"))
    if not pack_files:
        print(f"  ✗ No parquet files in {packs_dir}")
        return

    results = {}

    for i, pf in enumerate(pack_files, 1):
        pf_start = time.monotonic()
        # Orient expected dosage based on effect_allele:
        # TOPMed AF = frequency of the TOPMed ALT allele (column 4 of the AF variant_id).
        # The pack's variant_id col3:col4 may have DIFFERENT ordering than TOPMed REF:ALT
        # (11% of variants are swapped). So we compare effect_allele against the
        # TOPMed ALT allele (from a.variant_id), NOT the pack's col4.
        #
        #   effect_allele == TOPMed ALT: expected_dosage = 2 * AF
        #   effect_allele == TOPMed REF: expected_dosage = 2 * (1 - AF)
        #
        # Variance is symmetric (doesn't depend on orientation).
        try:
            rows = con.execute(f"""
                SELECT
                    p.pgs_id,
                    count(*) AS total_variants,
                    count(a.af) AS found,
                    SUM(CASE WHEN a.af IS NOT NULL THEN
                        p.effect_weight * CASE
                            WHEN p.effect_allele = split_part(a.variant_id, ':', 4)
                            THEN 2 * a.af
                            ELSE 2 * (1 - a.af)
                        END
                    ELSE 0 END) AS mean_score,
                    SQRT(SUM(CASE WHEN a.af IS NOT NULL
                        THEN p.effect_weight * p.effect_weight * 2 * a.af * (1 - a.af) ELSE 0 END)) AS sd_score
                FROM read_parquet('{pf}') p
                LEFT JOIN topmed_af a ON p.chr = a.chr AND p.pos = a.pos AND p.allele_key = a.allele_key
                WHERE p.pgs_id IN (SELECT unnest(list_value({','.join(f"'{p}'" for p in pgs_to_process)})))
                GROUP BY p.pgs_id
            """).fetchall()
        except Exception:
            # Fallback for packs without allele_key column (pre-migration)
            rows = con.execute(f"""
                SELECT
                    p.pgs_id,
                    count(*) AS total_variants,
                    count(a.af) AS found,
                    SUM(CASE WHEN a.af IS NOT NULL THEN
                        p.effect_weight * CASE
                            WHEN p.effect_allele = split_part(a.variant_id, ':', 4)
                            THEN 2 * a.af
                            ELSE 2 * (1 - a.af)
                        END
                    ELSE 0 END) AS mean_score,
                    SQRT(SUM(CASE WHEN a.af IS NOT NULL
                        THEN p.effect_weight * p.effect_weight * 2 * a.af * (1 - a.af) ELSE 0 END)) AS sd_score
                FROM read_parquet('{pf}') p
                LEFT JOIN topmed_af a ON p.chr = a.chr AND p.pos = a.pos
                    AND a.allele_key = ('0x' || md5(
                        LEAST(split_part(p.variant_id,':',3), split_part(p.variant_id,':',4))
                        || ':' ||
                        GREATEST(split_part(p.variant_id,':',3), split_part(p.variant_id,':',4))
                    )[:15])::BIGINT
                WHERE p.pgs_id IN (SELECT unnest(list_value({','.join(f"'{p}'" for p in pgs_to_process)})))
                GROUP BY p.pgs_id
            """).fetchall()

        for pgs_id, total, found, mean, sd in rows:
            coverage = round(found / total * 100, 2) if total > 0 else 0
            # Accumulate — a PGS can appear in multiple packs
            if pgs_id not in results or coverage > results[pgs_id]["coverage_pct"]:
                results[pgs_id] = {
                    "total_variants": total,
                    "found_in_topmed": found,
                    "coverage_pct": coverage,
                    "mean_score": float(mean) if mean is not None else None,
                    "stddev_score": float(sd) if sd is not None else None,
                }

        elapsed_pf = time.monotonic() - pf_start
        print(f"  [{i}/{len(pack_files)}] {pf.stem}: {len(rows)} PGS ({elapsed_pf:.0f}s)")

    con.close()

    with open(output_json, "w") as f:
        json.dump(results, f, indent=2)

    elapsed = time.monotonic() - start

    coverages = [r["coverage_pct"] for r in results.values()]
    good = sum(1 for c in coverages if c >= 50)
    low = sum(1 for c in coverages if c < 50)
    avg_cov = sum(coverages) / len(coverages) if coverages else 0

    print(f"\n  ✓ Computed {len(results)} PGS in {elapsed:.0f}s")
    print(f"    Average coverage: {avg_cov:.1f}%")
    print(f"    ≥50% coverage: {good}")
    print(f"    <50% coverage: {low}")
    print(f"    Output: {output_json}")


if __name__ == "__main__":
    panel_dir = sys.argv[1]
    packs_dir = sys.argv[2]
    output_json = sys.argv[3]
    pgs_list_file = sys.argv[4]

    af_tsv = str(Path(panel_dir) / "allele_frequencies.tsv")
    extract_topmed_af(panel_dir, af_tsv)
    compute_normalization(packs_dir, af_tsv, output_json, pgs_list_file)
