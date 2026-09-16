import marimo

__generated_with = "0.24.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo

    from lobster_nb.env import load_repo_env, secret_presence
    from lobster_nb.kalshi import ping
    from lobster_nb.lake import attach_lake, connect, r2_sql

    load_repo_env()
    return attach_lake, connect, mo, ping, r2_sql, secret_presence


@app.cell
def _(mo, secret_presence):
    presence = secret_presence()
    _lines = "\n".join(
        f"- `{name}`: {'set' if ok else 'missing'}" for name, ok in presence.items()
    )
    mo.md(
        f"""
        # Lake + Kalshi boot

        Run via `mise run notebooks` (uv + mise Python 3.12). Secrets come from
        the gitignored root `.env` — values are never printed.

        ## Secret presence

        {_lines}
        """
    )
    return (presence,)


@app.cell
def _(attach_lake, connect, mo):
    conn = connect()
    lake_status = attach_lake(conn)
    _ok = lake_status.get("ok")
    _detail = lake_status.get("alias") if _ok else lake_status.get("error")
    mo.md(
        f"""
        ## Iceberg attach

        Local DuckDB: `notebooks/.cache/kalshi.duckdb` (gitignored).

        Status: **{'attached' if _ok else 'failed'}** — `{_detail}`

        Query as `lake.options.kalshi_markets`. Do not `CREATE`/`INSERT` on `lake.*`.
        """
    )
    return conn, lake_status


@app.cell
def _(mo, ping):
    kalshi_status = ping()
    mo.md(
        f"""
        ## Kalshi signed GET

        `GET /exchange/status` → HTTP **{kalshi_status.get('status', 'n/a')}**
        (signed={kalshi_status.get('signed')}, ok={kalshi_status.get('ok')})
        {'' if kalshi_status.get('ok') else '— ' + str(kalshi_status.get('error') or '')}
        """
    )
    return (kalshi_status,)


@app.cell
def _(conn, lake_status, mo, r2_sql):
    if lake_status.get("ok"):
        tables = mo.sql(
            """
            SHOW ALL TABLES
            """,
            engine=conn,
        )
    else:
        _fallback = r2_sql(
            "SELECT market_ticker, theme, status FROM options.kalshi_markets LIMIT 5"
        )
        tables = _fallback.get("rows")
        mo.md(
            f"R2 SQL fallback ok={_fallback.get('ok')} "
            f"{_fallback.get('error') or ''}"
        )
    tables
    return (tables,)


if __name__ == "__main__":
    app.run()
