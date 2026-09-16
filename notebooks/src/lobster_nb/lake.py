"""Local DuckDB file + read-only Iceberg attach of the R2 options lake."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import duckdb

from lobster_nb.env import load_repo_env, repo_root

ACCOUNT = "3315bb3e7d2e3556bfea6fb3947a890e"
BUCKET = "cboe-options-data"
WAREHOUSE = f"{ACCOUNT}_{BUCKET}"
CATALOG_URI = f"https://catalog.cloudflarestorage.com/{ACCOUNT}/{BUCKET}"
LAKE_ALIAS = "lake"


def cache_dir() -> Path:
    path = repo_root() / "notebooks" / ".cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def cache_path() -> Path:
    return cache_dir() / "kalshi.duckdb"


def connect(path: Path | None = None) -> duckdb.DuckDBPyConnection:
    load_repo_env()
    db = path or cache_path()
    return duckdb.connect(str(db))


def attach_lake(conn: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """Attach `options.*` Iceberg tables as `lake`. Does not write to the catalog."""
    load_repo_env()
    token = (os.environ.get("R2_DATA_CATALOG_TOKEN") or "").strip()
    if not token:
        return {"ok": False, "error": "R2_DATA_CATALOG_TOKEN is not set"}

    attached = {
        row[0]
        for row in conn.execute("SELECT database_name FROM duckdb_databases()").fetchall()
    }
    if LAKE_ALIAS in attached:
        return {"ok": True, "attached": True, "alias": LAKE_ALIAS, "warehouse": WAREHOUSE}

    try:
        conn.execute("INSTALL iceberg")
        conn.execute("LOAD iceberg")
        conn.execute("INSTALL httpfs")
        conn.execute("LOAD httpfs")
        conn.execute("DROP SECRET IF EXISTS r2_catalog")
        # Bind the token as a parameter so it never appears in a logged SQL string.
        # DuckDB has no getenv() scalar; CREATE SECRET only accepts a bound literal.
        conn.execute(
            "CREATE SECRET r2_catalog (TYPE ICEBERG, TOKEN $token)",
            {"token": token},
        )
        conn.execute(
            f"ATTACH '{WAREHOUSE}' AS {LAKE_ALIAS} ("
            f"TYPE ICEBERG, ENDPOINT '{CATALOG_URI}', SECRET r2_catalog, READ_ONLY"
            f")"
        )
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:500]}
    return {"ok": True, "attached": True, "alias": LAKE_ALIAS, "warehouse": WAREHOUSE}


def r2_sql(query: str, timeout_s: float = 60.0) -> dict[str, Any]:
    """Fallback: the same R2 SQL HTTP API the Worker uses."""
    import httpx

    load_repo_env()
    token = (os.environ.get("R2_SQL_TOKEN") or os.environ.get("WRANGLER_R2_SQL_AUTH_TOKEN") or "").strip()
    if not token:
        return {"ok": False, "error": "R2_SQL_TOKEN is not set"}
    account = (os.environ.get("R2_SQL_ACCOUNT_ID") or ACCOUNT).strip()
    bucket = (os.environ.get("R2_SQL_BUCKET") or BUCKET).strip()
    url = (
        f"https://api.sql.cloudflarestorage.com/api/v1/accounts/"
        f"{account}/r2-sql/query/{bucket}"
    )
    try:
        response = httpx.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"query": query},
            timeout=timeout_s,
        )
        payload = response.json()
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:500]}
    if response.status_code >= 400 or not payload.get("success"):
        msg = ""
        errors = payload.get("errors") if isinstance(payload, dict) else None
        if isinstance(errors, list) and errors:
            msg = str(errors[0].get("message", errors[0]))
        return {"ok": False, "error": (msg or f"R2 SQL HTTP {response.status_code}")[:500]}
    rows = (payload.get("result") or {}).get("rows") or []
    return {"ok": True, "rows": rows}
