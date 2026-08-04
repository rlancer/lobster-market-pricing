"""FastAPI server exposing the DuckDB-backed option screener API."""
from __future__ import annotations

from datetime import date
from typing import Any

import duckdb
from fastapi import Body, FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from .db import connect

app = FastAPI(title="S&P 500 Options Screener API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _rows(con, sql: str, params: list[Any] | None = None) -> list[dict]:
    cur = con.execute(sql, params or [])
    cols = [d[0] for d in cur.description]
    out = []
    for r in cur.fetchall():
        row = {}
        for c, v in zip(cols, r):
            if isinstance(v, date):
                row[c] = v.isoformat()
            else:
                row[c] = v
        out.append(row)
    return out


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/stats")
def stats() -> dict:
    con = connect(read_only=True)
    n_sym = con.execute("SELECT COUNT(*) FROM underlyings").fetchone()[0]
    n_con = con.execute("SELECT COUNT(*) FROM option_contracts").fetchone()[0]
    n_calls = con.execute("SELECT COUNT(*) FROM option_contracts WHERE type='call'").fetchone()[0]
    n_puts = con.execute("SELECT COUNT(*) FROM option_contracts WHERE type='put'").fetchone()[0]
    last = con.execute(
        "SELECT COALESCE(MAX(fetched_at)::VARCHAR, '') FROM option_contracts"
    ).fetchone()[0]
    return {
        "underlyings": n_sym,
        "contracts": n_con,
        "calls": n_calls,
        "puts": n_puts,
        "last_updated": last,
    }


@app.get("/api/sectors")
def sectors() -> list[dict]:
    con = connect(read_only=True)
    return _rows(
        con,
        """SELECT sector, COUNT(*) AS symbols, AVG(spot) AS avg_spot
           FROM underlyings GROUP BY sector ORDER BY sector""",
    )


@app.get("/api/underlyings")
def underlyings(sector: str | None = None, q: str | None = None,
                limit: int = 50, offset: int = 0) -> dict:
    con = connect(read_only=True)
    where = []
    params: list[Any] = []
    if sector:
        where.append("u.sector = ?")
        params.append(sector)
    if q:
        where.append("(UPPER(u.symbol) LIKE ? OR UPPER(u.name) LIKE ?)")
        params += [f"%{q.upper()}%", f"%{q.upper()}%"]
    clause = ("WHERE " + " AND ".join(where)) if where else ""

    total = con.execute(
        f"SELECT COUNT(*) FROM underlyings u {clause}", params
    ).fetchone()[0]

    params += [limit, offset]
    rows = _rows(
        con,
        f"""SELECT u.symbol, u.name, u.sector, u.spot,
                   (SELECT COUNT(*) FROM option_contracts c WHERE c.symbol=u.symbol) AS contracts
            FROM underlyings u {clause}
            ORDER BY u.symbol LIMIT ? OFFSET ?""",
        params,
    )
    return {"total": total, "items": rows}


@app.get("/api/screen")
def screen(
    symbol: str | None = None,
    type: str | None = Query(None, pattern="^(call|put)$"),
    sector: str | None = None,
    min_strike: float | None = None,
    max_strike: float | None = None,
    min_volume: int | None = None,
    min_open_interest: int | None = None,
    min_iv: float | None = None,
    max_iv: float | None = None,
    min_delta: float | None = None,
    max_delta: float | None = None,
    in_the_money: bool | None = None,
    expiration_before: str | None = None,
    expiration_after: str | None = None,
    near_spot_strikes: int | None = 50,
    sort: str = "volume",
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = 100,
    offset: int = 0,
) -> dict:
    con = connect(read_only=True)
    where = ["c.symbol IS NOT NULL"]
    params: list[Any] = []
    if symbol:
        where.append("c.symbol = ?")
        params.append(symbol.upper())
    if type:
        where.append("c.type = ?")
        params.append(type)
    if sector:
        where.append("u.sector = ?")
        params.append(sector)
    if min_strike is not None:
        where.append("c.strike >= ?"); params.append(min_strike)
    if max_strike is not None:
        where.append("c.strike <= ?"); params.append(max_strike)
    if min_volume is not None:
        where.append("COALESCE(c.volume,0) >= ?"); params.append(min_volume)
    if min_open_interest is not None:
        where.append("COALESCE(c.open_interest,0) >= ?"); params.append(min_open_interest)
    if min_iv is not None:
        where.append("c.implied_vol >= ?"); params.append(min_iv)
    if max_iv is not None:
        where.append("c.implied_vol <= ?"); params.append(max_iv)
    if min_delta is not None:
        where.append("c.delta >= ?"); params.append(min_delta)
    if max_delta is not None:
        where.append("c.delta <= ?"); params.append(max_delta)
    if in_the_money is not None:
        where.append("c.in_the_money = ?"); params.append(in_the_money)
    if expiration_before:
        where.append("c.expiration <= ?"); params.append(expiration_before)
    if expiration_after:
        where.append("c.expiration >= ?"); params.append(expiration_after)

    # Limit each underlying to its N strikes nearest spot (ATM band). Off when
    # 0/None. Implemented as a CTE over DISTINCT (symbol, strike) ranked by
    # |strike - spot|, then an EXISTS filter on the main query.
    cte = ""
    if near_spot_strikes and near_spot_strikes > 0:
        cte = (
            "WITH atm_strikes AS (\n"
            "  SELECT symbol, strike FROM (\n"
            "    SELECT ds.symbol, ds.strike,\n"
            "           ROW_NUMBER() OVER (PARTITION BY ds.symbol\n"
            "                              ORDER BY ABS(ds.strike - au.spot)) AS rn\n"
            "    FROM (SELECT DISTINCT c2.symbol, c2.strike FROM option_contracts c2\n"
            "          JOIN underlyings u2 ON u2.symbol = c2.symbol\n"
            "          WHERE u2.spot IS NOT NULL) ds\n"
            "    JOIN underlyings au ON au.symbol = ds.symbol\n"
            "  ) WHERE rn <= ?\n"
            ")\n"
        )
        where.append(
            "EXISTS (SELECT 1 FROM atm_strikes a "
            "WHERE a.symbol = c.symbol AND a.strike = c.strike)"
        )
        # the CTE's `?` precedes the WHERE params in the SQL text
        params = [near_spot_strikes] + params

    clause = "WHERE " + " AND ".join(where)

    allowed_sort = {
        "volume", "open_interest", "strike", "implied_vol", "delta",
        "theta", "vega", "gamma", "bid", "ask", "last", "expiration",
    }
    sort_col = sort if sort in allowed_sort else "volume"
    null_sort = "c.implied_vol" if sort_col in ("implied_vol", "delta", "gamma", "theta", "vega") else sort_col
    sort_expr = f"COALESCE(c.{sort_col},0)" if sort_col != "expiration" else f"c.{sort_col}"

    total = con.execute(
        f"""{cte}SELECT COUNT(*) FROM option_contracts c
            LEFT JOIN underlyings u ON u.symbol = c.symbol {clause}""",
        params,
    ).fetchone()[0]

    qparams = params + [limit, offset]
    rows = _rows(
        con,
        f"""{cte}SELECT c.symbol, u.name AS name, u.sector AS sector, u.spot AS spot,
                   c.expiration, c.type, c.strike, c.last, c.bid, c.ask,
                   c.volume, c.open_interest, c.implied_vol,
                   c.delta, c.gamma, c.theta, c.vega, c.rho, c.in_the_money,
                   CASE WHEN u.spot IS NOT NULL AND c.strike > 0
                        THEN ROUND((c.strike - u.spot)/u.spot*100, 2) END AS moneyness_pct
            FROM option_contracts c
            LEFT JOIN underlyings u ON u.symbol = c.symbol
            {clause}
            ORDER BY {sort_expr} {order.upper()}, c.symbol ASC
            LIMIT ? OFFSET ?""",
        qparams,
    )
    return {"total": total, "items": rows}


@app.get("/api/symbol/{symbol}")
def symbol_detail(symbol: str) -> dict:
    """Return one underlying's info plus all its option contracts,
    ordered by expiration, strike, type (for chain grouping client-side)."""
    con = connect(read_only=True)
    sym = symbol.upper()
    u = con.execute(
        "SELECT symbol, name, sector, spot, fetched_at FROM underlyings WHERE symbol = ?",
        [sym],
    ).fetchone()
    if not u:
        return {"underlying": None, "contracts": [], "expirations": []}
    underlying = {
        "symbol": u[0], "name": u[1], "sector": u[2], "spot": u[3],
        "fetched_at": u[4].isoformat() if u[4] else None,
    }
    rows = _rows(
        con,
        """SELECT expiration, type, strike, last, bid, ask,
                  volume, open_interest, implied_vol,
                  delta, gamma, theta, vega, rho, in_the_money
           FROM option_contracts WHERE symbol = ?
           ORDER BY expiration, strike, type""",
        [sym],
    )
    expirations = sorted({r["expiration"] for r in rows})
    return {
        "underlying": underlying,
        "contracts": rows,
        "expirations": expirations,
        "n_contracts": len(rows),
    }


@app.get("/api/symbols")
def symbols(q: str | None = None, limit: int = 50) -> list[dict]:
    """Ticker typeahead. Matches on symbol prefix first, then name substring,
    so users can search by company name (e.g. "Apple" -> AAPL).
    Returns [{symbol, name, sector}, ...]."""
    con = connect(read_only=True)
    if not q:
        return _rows(
            con,
            """SELECT symbol, name, sector FROM underlyings
               ORDER BY symbol LIMIT ?""",
            [limit],
        )
    like = f"%{q.upper()}%"
    # rank: exact > symbol prefix > symbol substring > name match
    return _rows(
        con,
        """SELECT symbol, name, sector FROM underlyings
           WHERE UPPER(symbol) LIKE ? OR UPPER(COALESCE(name, '')) LIKE ?
           ORDER BY
             CASE
               WHEN UPPER(symbol) = ? THEN 0
               WHEN UPPER(symbol) LIKE ? THEN 1
               ELSE 2
             END,
             symbol
           LIMIT ?""",
        [like, like, q.upper(), f"{q.upper()}%", limit],
    )


# ---------------------------------------------------------------------------
# Data Explorer: introspect schema + run arbitrary read-only SQL
# ---------------------------------------------------------------------------

_EXPLORER_MAX_ROWS = 1000


def _list_tables(con: duckdb.DuckDBPyConnection) -> list[dict]:
    # user tables only (schema 'main')
    names = [
        r[0]
        for r in con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'main' ORDER BY table_name"
        ).fetchall()
    ]
    out: list[dict] = []
    for name in names:
        cols = [
            {"name": c, "type": t}
            for c, t in con.execute(
                "SELECT column_name, data_type FROM information_schema.columns "
                "WHERE table_schema = 'main' AND table_name = ? "
                "ORDER BY ordinal_position",
                [name],
            ).fetchall()
        ]
        try:
            row_count = con.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        except Exception:
            row_count = None
        out.append({"name": name, "row_count": row_count, "columns": cols})
    return out


@app.get("/api/tables")
def tables() -> list[dict]:
    """List all user tables with columns, types, and row counts."""
    con = connect(read_only=True)
    return _list_tables(con)


def _sanitize_sql(sql: str) -> str:
    """Reject anything that isn't a single read-only SELECT/WITH query."""
    cleaned = sql.strip().rstrip(";").strip()
    if not cleaned:
        raise ValueError("Empty query")
    if ";" in cleaned:
        raise ValueError("Multiple statements are not allowed; please run one query at a time")
    head = cleaned.lstrip("(").lstrip().split(None, 1)[0].upper() if cleaned.lstrip("(").lstrip() else ""
    if head not in {"SELECT", "WITH", "DESCRIBE", "DESC", "SHOW", "EXPLAIN", "PRAGMA"}:
        raise ValueError(
            "Only read-only queries (SELECT/WITH/DESCRIBE/SHOW/EXPLAIN/PRAGMA) are allowed"
        )
    # block obvious write/DDL keywords anywhere as an extra guardrail
    lowered = cleaned.lower()
    for kw in (
        "insert into", "update ", "delete from", "drop ", "create ", "alter ",
        "truncate ", "attach ", "detach ", "copy ", "load ", "install ",
    ):
        if kw in lowered:
            raise ValueError(f"Disallowed keyword: {kw.strip()}")
    return cleaned


@app.post("/api/query")
def query(body: dict = Body(...)) -> dict:
    """Run an arbitrary read-only SQL query and return columns + rows."""
    sql_in = body.get("sql") or ""
    limit = int(body.get("limit") or _EXPLORER_MAX_ROWS)
    limit = max(1, min(limit, _EXPLORER_MAX_ROWS))
    try:
        sql = _sanitize_sql(sql_in)
    except ValueError as e:
        return {"error": str(e), "columns": [], "rows": []}

    con = connect(read_only=True)
    try:
        wrapped = f"SELECT * FROM ({sql}) AS __q LIMIT {limit}"
        cur = con.execute(wrapped)
        cols = [d[0] for d in cur.description]
        fetched = cur.fetchall()
    except Exception as e:
        return {"error": str(e), "columns": [], "rows": []}

    rows: list[dict] = []
    for r in fetched:
        row: dict[str, Any] = {}
        for c, v in zip(cols, r):
            if isinstance(v, date):
                row[c] = v.isoformat()
            elif isinstance(v, (list, dict)):
                row[c] = str(v)
            else:
                row[c] = v
        rows.append(row)
    return {
        "columns": cols,
        "rows": rows,
        "row_count": len(rows),
        "truncated": len(rows) >= limit,
        "limit": limit,
    }


def main() -> None:
    import uvicorn
    uvicorn.run("screener.server:app", host="127.0.0.1", port=8001, reload=False)


if __name__ == "__main__":
    main()
