"""DuckDB schema and connection helpers for the options screener."""
from __future__ import annotations

from pathlib import Path
import duckdb

DB_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "options.duckdb"


def connect(read_only: bool = False) -> duckdb.DuckDBPyConnection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(DB_PATH), read_only=read_only)


def init_schema(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS underlyings (
            symbol            VARCHAR,
            name              VARCHAR,
            sector            VARCHAR,
            spot              DOUBLE,
            fetched_at        TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS option_contracts (
            symbol            VARCHAR,
            expiration        DATE,
            type              VARCHAR,       -- 'call' | 'put'
            strike            DOUBLE,
            last              DOUBLE,
            bid               DOUBLE,
            ask               DOUBLE,
            volume            BIGINT,
            open_interest     BIGINT,
            implied_vol       DOUBLE,
            delta             DOUBLE,
            gamma             DOUBLE,
            theta             DOUBLE,
            vega               DOUBLE,
            rho               DOUBLE,
            in_the_money      BOOLEAN,
            fetched_at        TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS download_log (
            run_id            VARCHAR,
            symbol            VARCHAR,
            expirations       BIGINT,
            contracts         BIGINT,
            status            VARCHAR,
            error             VARCHAR,
            started_at        TIMESTAMP,
            finished_at       TIMESTAMP
        );
        """
    )


def reset(con: duckdb.DuckDBPyConnection) -> None:
    """Drop and recreate all tables (used before a full refresh)."""
    con.execute("DROP TABLE IF EXISTS underlyings")
    con.execute("DROP TABLE IF EXISTS option_chains")
    con.execute("DROP TABLE IF EXISTS option_contracts")
    con.execute("DROP TABLE IF EXISTS download_log")
    init_schema(con)
