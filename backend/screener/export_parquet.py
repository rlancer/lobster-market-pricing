"""Export DuckDB tables to Parquet for static (Cloudflare R2) serving.

This is the bridge between the local data pipeline (download_cboe.py -> DuckDB)
and the static frontend, which reads Parquet over HTTP from R2 via
DuckDB-WASM (see DEPLOYMENT-CLOUDFLARE.md).

Writes, for each table in TABLES:
    data/parquet/<table>.parquet

and a small manifest.json with row counts, sizes, sha256, and a generated_at
timestamp, which the browser uses for cache-busting (?v=<version>) on every
read_parquet() URL.

Usage:
    uv run python -m screener.export_parquet
    uv run python -m screener.export_parquet --out data/parquet
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .db import DB_PATH, connect

# Tables to export, in dependency-safe order. Names are also the file basenames.
TABLES = ("underlyings", "option_contracts", "download_log")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def export(out_dir: Path, *, write_manifest: bool = True) -> dict:
    """Export all tables to <out_dir>/<table>.parquet; return the manifest dict."""
    out_dir.mkdir(parents=True, exist_ok=True)
    con = connect(read_only=True)
    manifest_files: list[dict] = []
    for table in TABLES:
        # Sanity check the table exists and is non-empty.
        row_count = con.execute(
            f'SELECT COUNT(*) FROM "{table}"'
        ).fetchone()[0]
        dest = out_dir / f"{table}.parquet"
        # COPY ... TO writes Parquet directly from DuckDB.
        con.execute(
            f"COPY (SELECT * FROM \"{table}\") TO '{dest.as_posix()}' "
            f"(FORMAT PARQUET, COMPRESSION 'zstd');"
        )
        size = dest.stat().st_size
        sha = _sha256(dest)
        print(f"  {table:18s} rows={row_count:>8d}  {size/1024:8.1f} KB  sha={sha[:12]}…")
        manifest_files.append({
            "name": f"{table}.parquet",
            "table": table,
            "rows": row_count,
            "bytes": size,
            "sha256": sha,
        })

    manifest = {
        "version": datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": str(DB_PATH),
        "files": manifest_files,
    }
    if write_manifest:
        mpath = out_dir / "manifest.json"
        mpath.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(f"  manifest.json      -> {mpath}")
    return manifest


def main() -> None:
    default_out = DB_PATH.parent / "parquet"
    ap = argparse.ArgumentParser(description="Export DuckDB tables to Parquet")
    ap.add_argument(
        "--out", default=str(default_out),
        help=f"Output directory (default: {default_out})",
    )
    ap.add_argument(
        "--no-manifest", action="store_true",
        help="Skip writing manifest.json",
    )
    args = ap.parse_args()

    out = Path(args.out).resolve()
    print(f"Exporting tables from {DB_PATH} -> {out}")
    manifest = export(out, write_manifest=not args.no_manifest)
    total_bytes = sum(f["bytes"] for f in manifest["files"])
    print(
        f"Done. {len(manifest['files'])} files, "
        f"{total_bytes/1024/1024:.1f} MB total, version={manifest['version']}"
    )


if __name__ == "__main__":
    main()
