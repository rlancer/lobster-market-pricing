#!/usr/bin/env python3
"""Rewrite (overwrite) an R2 Data Catalog Iceberg table, either to purge rows or
to collapse it to its latest-wins view. Intended for one-off data hygiene on
append-only Iceberg tables (see loader/AGENTS.md → "R2 Data Catalog maintenance").

Overwrite is an ATOMIC catalog commit: it rewrites the table's data files in
one new snapshot and the old files become orphaned snapshots that the hourly
compaction + snapshot-expiration maintenance reclaims. Because the table is
recreated in place, R2 SQL and the screener worker see the new contents
immediately after the commit.

Usage (from loader/):
  export R2_DATA_CATALOG_TOKEN=<token>   # R2 Storage Admin R&W + Data Catalog R&W
  python tools/iceberg_rewrite.py corporate_actions --exclude ticker=PROBE
  python tools/iceberg_rewrite.py ohlc --exclude symbol=TEST
  python tools/iceberg_rewrite.py securities --dedupe ticker --drop ticker=PROBE
  python tools/iceberg_rewrite.py ohlc --dedupe symbol,date

Options:
  --exclude <col>=<val>   drop rows where col == val (repeatable; any match drops)
  --dedupe  <keys>        keep the newest row per key (by fetched_at desc). When
                          --dedupe is used the data goes through pandas (required
                          fields are cast back to the table schema before commit).
  --account / --bucket / --token   override defaults (defaults match this repo).

Notes / gotchas:
  - The overwrite rewrites the WHOLE table. Do not run it while the pipeline sink
    for that table is actively ingesting (commit conflicts are possible, though
    they are surfaced as errors and the table is left unchanged).
  - Prefer a row-scoped, non-rewrite path (e.g. a PySpark DELETE ... WHERE) for
    very large, frequently-appended tables; only the targeted delete files are
    written, and compaction reclaims bytes hourly.
  - Requires: pip install "pyiceberg[pyiceberg-core]" pyarrow pandas (the
    pyiceberg-core extra is required for partition transforms on sink tables,
    which are partitioned by day(__ingest_ts)).
"""

import argparse
import os

import pyarrow as pa
import pyarrow.compute as pc
from pyiceberg.catalog.rest import RestCatalog

# Repo defaults (overridable via flags / env).
DEFAULT_ACCOUNT = "3315bb3e7d2e3556bfea6fb3947a890e"
DEFAULT_BUCKET = "cboe-options-data"
WAREHOUSE_PREFIX = "_cboe-options-data"


def parse_excludes(specs: list[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for s in specs:
        key, sep, val = s.partition("=")
        if not sep:
            raise SystemExit(f"--exclude expects COL=VAL, got: {s!r}")
        out.append((key, val))
    return out


def connect(args) -> tuple[RestCatalog, tuple, object]:
    account = args.account or os.environ.get("R2_DATA_CATALOG_ACCOUNT", DEFAULT_ACCOUNT)
    bucket = args.bucket or os.environ.get("R2_DATA_CATALOG_BUCKET", DEFAULT_BUCKET)
    token = args.token or os.environ.get("R2_DATA_CATALOG_TOKEN")
    if not token:
        raise SystemExit("R2_DATA_CATALOG_TOKEN is not set")
    catalog = RestCatalog(
        name="r2",
        warehouse=account + WAREHOUSE_PREFIX,
        uri=f"https://catalog.cloudflarestorage.com/{account}/{bucket}",
        token=token,
    )
    table = catalog.load_table(("options", args.table))
    return catalog, ("options", args.table), table


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("table", help="table name under the options namespace")
    p.add_argument("--exclude", action="append", default=[], metavar="COL=VAL")
    p.add_argument("--dedupe", default=None, metavar="key1,key2")
    p.add_argument("--account", default=None)
    p.add_argument("--bucket", default=None)
    p.add_argument("--token", default=None)
    p.add_argument("--dry-run", action="store_true", help="report counts, do not commit")
    args = p.parse_args()

    catalog, ident, table = connect(args)

    scan = table.scan().to_arrow()
    before = scan.num_rows

    excludes = parse_excludes(args.exclude)
    for col, val in excludes:
        if col not in scan.column_names:
            raise SystemExit(f"column {col!r} not in {args.table}")
        # Keep rows where the column is NULL (never equal to val) or != val.
        keep = pc.or_kleene(pc.field(col).is_null(), pc.not_equal(pc.field(col), val))
        scan = scan.filter(keep)
    n_excluded = before - scan.num_rows

    if args.dedupe:
        keys = [k.strip() for k in args.dedupe.split(",")]
        if not keys:
            raise SystemExit("--dedupe needs at least one key")
        missing = [k for k in keys if k not in scan.column_names]
        if missing:
            raise SystemExit(f"missing dedupe keys: {missing}")
        df = scan.to_pandas()
        df = df.sort_values("fetched_at", kind="stable").drop_duplicates(subset=keys, keep="last")
        scan = pa.Table.from_pandas(df, preserve_index=False).cast(
            table.schema().as_arrow(), safe=False
        )

    after = scan.num_rows
    print(f"{args.table}: {before} -> {after}  (excluded={n_excluded}, deduped={before - n_excluded - after})")

    if args.dry_run:
        print("dry-run: not committing")
        return

    table.overwrite(scan)
    table.refresh()
    print(f"committed new snapshot: {table.metadata.current_snapshot().snapshot_id}")


if __name__ == "__main__":
    main()
