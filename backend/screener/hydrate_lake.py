"""Hydrate the local DuckDB from the CBOE Iceberg lake via Cloudflare R2 SQL.

This replaces the old `download_cboe.py` direct-from-CBOE path. The loader
project (cboe-to-r2) owns ingestion: CBOE -> Cloudflare Pipelines -> R2 Data
Catalog Iceberg tables (options.option_contracts, options.underlyings). This
module is the *consumer*: it reads the latest per-symbol snapshot from the
lake over the R2 SQL REST API and writes it into data/options.duckdb in the
exact schema `db.py` / `server.py` expect, so the screener API and the
DuckDB-WASM frontend both run unchanged.

Name/sector enrichment: the loader enriches underlyings with `name`/`sector`
from the S&P 500 Wikipedia constituents manifest at publish time. If the lake's
`underlyings` table does not yet carry those columns (e.g. before the loader
schema recreation lands), this module falls back to merging them locally from
`sp500.fetch_sp500()` so the screener's sector filter and symbol typeahead keep
working. Once the lake carries name/sector, the local fallback is a no-op.

Usage:
    uv run python -m screener.hydrate_lake
    uv run python -m screener.hydrate_lake --limit 25   # smoke test (first N symbols)

Env (see .env):
    R2_SQL_ACCOUNT_ID   Cloudflare account ID
    R2_SQL_BUCKET       R2 bucket name (catalog warehouse suffix)
    R2_SQL_TOKEN        R2 API token (Admin R&W + R2 SQL Read)
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import os
import time
from datetime import datetime, timezone
from typing import Any

import requests

from .db import connect, init_schema, reset
from .sp500 import fetch_sp500

# ---------------------------------------------------------------------------
# R2 SQL REST client
# ---------------------------------------------------------------------------
API_BASE = "https://api.sql.cloudflarestorage.com/api/v1/accounts/{account}/r2-sql/query/{bucket}"
DEFAULT_LIMIT = 10000  # R2 SQL max page size; well above any single symbol's chain


def _env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if not value:
        raise RuntimeError(f"missing required env var: {name}")
    return value.strip()


def _client() -> tuple[str, dict[str, str]]:
    account = _env("R2_SQL_ACCOUNT_ID")
    bucket = _env("R2_SQL_BUCKET")
    token = _env("R2_SQL_TOKEN")
    url = API_BASE.format(account=account, bucket=bucket)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    return url, headers


# module-level client (reused across threads)
_URL, _HEADERS = "", {}
_initialised = False


def _init_client() -> None:
    global _URL, _HEADERS, _initialised
    if not _initialised:
        _URL, _HEADERS = _client()
        _initialised = True


def r2sql(query: str, *, timeout: int = 240) -> list[dict[str, Any]]:
    """Execute a read-only SQL query against the Iceberg lake; return rows."""
    _init_client()
    resp = requests.post(_URL, headers=_HEADERS, json={"query": query}, timeout=timeout)
    body = resp.json()
    if not body.get("success"):
        errors = body.get("errors") or []
        msg = errors[0].get("message", str(errors)) if errors else f"HTTP {resp.status}"
        raise RuntimeError(f"R2 SQL error: {msg}")
    result = body.get("result") or {}
    rows = result.get("rows") or []
    metrics = result.get("metrics")
    if metrics:
        scanned = metrics.get("bytes_scanned", 0)
        files_ = metrics.get("files_scanned", 0)
        print(f"    [r2sql] files_scanned={files_} bytes_scanned={scanned} rows={len(rows)}")
    return rows


# ---------------------------------------------------------------------------
# Schema discovery — the underlyings table gains name/sector after the loader
# recreation; query defensively so this works before and after.
def _underlying_columns() -> set[str]:
    rows = r2sql("DESCRIBE options.underlyings")
    return {r["column_name"] for r in rows}


def fetch_latest_underlyings() -> list[dict[str, Any]]:
    cols = _underlying_columns()
    has_name = "name" in cols
    has_sector = "sector" in cols
    select = "symbol, spot_price, run_id, fetched_at"
    if has_name:
        select += ", name"
    if has_sector:
        select += ", sector"
    # QUALIFY must follow WHERE; no WHERE needed here so the engine places it.
    sql = f"SELECT {select} FROM options.underlyings QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fetched_at DESC) = 1 LIMIT {DEFAULT_LIMIT}"
    return r2sql(sql)


def fetch_symbol_contracts(symbol: str, run_id: str) -> list[dict[str, Any]]:
    """All contracts for one symbol in its latest run. Single-quote literals
    per R2 SQL string conventions; run_id/symbol are UUIDs/tickers — safe."""
    sql = (
        "SELECT symbol, expiration, type, strike, last, bid, ask, volume, "
        "open_interest, implied_vol, delta, gamma, theta, vega, rho, "
        "in_the_money, theo, bid_size, ask_size, fetched_at "
        f"FROM options.option_contracts WHERE symbol = '{symbol}' "
        f"AND run_id = '{run_id}' "
        f"ORDER BY expiration, strike, type LIMIT {DEFAULT_LIMIT}"
    )
    return r2sql(sql)


# ---------------------------------------------------------------------------
# Local name/sector fallback (used until the lake carries name/sector)
# ---------------------------------------------------------------------------
_WIKI_CACHE: dict[str, dict[str, str]] | None = None


def _wiki_map() -> dict[str, dict[str, str]]:
    global _WIKI_CACHE
    if _WIKI_CACHE is None:
        try:
            constituents = fetch_sp500()
            _WIKI_CACHE = {
                c["symbol"]: {"name": c["name"], "sector": c["sector"]}
                for c in constituents
            }
            print(f"  Wikipedia constituents: {len(_WIKI_CACHE)} symbols")
        except Exception as exc:
            print(f"  WARNING: Wikipedia fetch failed ({exc}); name/sector will be NULL")
            _WIKI_CACHE = {}
    return _WIKI_CACHE


# ---------------------------------------------------------------------------
# DuckDB write (schema matches db.py exactly)
# ---------------------------------------------------------------------------
def _to_ts(v: Any) -> str | None:
    """R2 SQL returns fetched_at as an RFC3339 string; DuckDB accepts it as a
    TIMESTAMP literal. Pass through (None stays None)."""
    return v


def _to_date_str(v: Any) -> str | None:
    """expiration is TEXT 'YYYY-MM-DD' in the lake; DuckDB casts it to DATE on
    insert via the parameter binding."""
    return v


def write_duckdb(
    underlyings: list[dict[str, Any]],
    contracts: dict[str, list[dict[str, Any]]],
) -> None:
    con = connect()
    init_schema(con)
    reset(con)

    wiki = _wiki_map()
    underlying_rows: list[tuple] = []
    for u in underlyings:
        sym = u["symbol"]
        name = u.get("name")
        sector = u.get("sector")
        if not name:
            name = wiki.get(sym, {}).get("name")
        if not sector:
            sector = wiki.get(sym, {}).get("sector", "Unknown")
        spot = u.get("spot_price")
        fetched_at = u.get("fetched_at")
        underlying_rows.append((sym, name, sector, spot, fetched_at))

    contract_rows: list[tuple] = []
    log_rows: list[tuple] = []
    for sym, rows in contracts.items():
        if not rows:
            continue
        expirations: set[str] = set()
        for r in rows:
            contract_rows.append((
                r["symbol"], r["expiration"], r["type"], r["strike"],
                r.get("last"), r.get("bid"), r.get("ask"), r.get("volume"),
                r.get("open_interest"), r.get("implied_vol"),
                r.get("delta"), r.get("gamma"), r.get("theta"),
                r.get("vega"), r.get("rho"), r.get("in_the_money"),
                r.get("theo"), r.get("bid_size"), r.get("ask_size"),
                r.get("fetched_at"),
            ))
            expirations.add(r["expiration"])
        fetched_at = rows[0].get("fetched_at")
        log_rows.append((
            "lake-hydrate", sym, len(expirations), len(rows),
            "ok", None, fetched_at, fetched_at,
        ))

    con.execute("BEGIN TRANSACTION")
    try:
        con.executemany(
            "INSERT INTO option_contracts VALUES "
            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            contract_rows,
        )
        con.executemany(
            "INSERT INTO underlyings VALUES (?, ?, ?, ?, ?)", underlying_rows,
        )
        con.executemany(
            "INSERT INTO download_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)", log_rows,
        )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise

    n_con = con.execute("SELECT COUNT(*) FROM option_contracts").fetchone()[0]
    n_und = con.execute("SELECT COUNT(*) FROM underlyings").fetchone()[0]
    print(f"\n  DuckDB hydrated: underlyings={n_und} contracts={n_con} "
          f"symbols_with_contracts={len(contracts)}")
    con.close()


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------
def hydrate(limit: int | None = None, workers: int = 16) -> int:
    print("=== Hydrate from CBOE Iceberg lake (R2 SQL) ===")
    t0 = time.time()

    print("  Fetching latest underlyings snapshot ...")
    underlyings = fetch_latest_underlyings()
    print(f"  underlyings: {len(underlyings)} symbols from lake")

    # Build (symbol, run_id) pairs for the latest per-symbol run.
    # run_id is required on every underlying record in the lake.
    sym_runs: list[tuple[str, str]] = []
    for u in underlyings:
        sym = u["symbol"]
        run_id = u.get("run_id")
        if not run_id:
            # Fallback: query the latest run_id for this symbol directly.
            rows = r2sql(
                f"SELECT run_id FROM options.underlyings WHERE symbol = '{sym}' "
                f"ORDER BY fetched_at DESC LIMIT 1"
            )
            run_id = rows[0]["run_id"] if rows else None
        if run_id:
            sym_runs.append((sym, run_id))

    if limit:
        sym_runs = sym_runs[:limit]
        print(f"  --limit {limit}: hydrating first {len(sym_runs)} symbols")

    print(f"  Fetching contracts for {len(sym_runs)} symbols "
          f"({workers} concurrent) ...")
    contracts: dict[str, list[dict[str, Any]]] = {}
    failed: list[tuple[str, str]] = []
    done = 0
    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(fetch_symbol_contracts, sym, rid): sym
            for sym, rid in sym_runs
        }
        for fut in cf.as_completed(futures):
            sym = futures[fut]
            try:
                rows = fut.result()
                contracts[sym] = rows
                done += 1
                if done % 50 == 0 or done == len(sym_runs):
                    print(f"    progress: {done}/{len(sym_runs)} symbols")
            except Exception as exc:
                failed.append((sym, str(exc)))
                contracts[sym] = []
    if failed:
        print(f"  WARNING: {len(failed)} symbols failed:")
        for sym, err in failed[:10]:
            print(f"    {sym}: {err[:120]}")

    # Drop underlyings with zero contracts (no chain in latest run).
    live_syms = {s for s, rs in contracts.items() if rs}
    underlyings_live = [u for u in underlyings if u["symbol"] in live_syms]

    print(f"  Writing to DuckDB ...")
    write_duckdb(underlyings_live, contracts)

    elapsed = time.time() - t0
    print(f"=== Hydrate complete in {elapsed:.1f}s ===")
    return len(failed)


def main() -> None:
    p = argparse.ArgumentParser(description="Hydrate DuckDB from the CBOE Iceberg lake")
    p.add_argument("--limit", type=int, default=None,
                   help="smoke test: only hydrate the first N symbols")
    p.add_argument("--workers", type=int, default=16,
                   help="concurrent R2 SQL workers for contracts fetch")
    args = p.parse_args()
    errors = hydrate(limit=args.limit, workers=args.workers)
    if errors:
        raise SystemExit(f"{errors} symbol(s) failed to hydrate")


if __name__ == "__main__":
    main()
