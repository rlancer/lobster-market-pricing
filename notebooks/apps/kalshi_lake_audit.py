import marimo

__generated_with = "0.24.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    from lobster_nb.env import load_repo_env, secret_presence
    from lobster_nb.lake import attach_lake, connect

    return attach_lake, connect, mo, secret_presence


@app.cell
def _(mo):
    mo.md("""
    # Kalshi parlay lake audit

    Verifies what Kalshi parlay data is in the lake and how it gets there.

    - **What we have:** row counts and coverage for the sports parlay
      universe (`theme='sports'`) in `lake.options.kalshi_markets` —
      two-leg combos (`category LIKE 'mve|%'`), legs, RFQ two-ways
      (`source=kalshi_rfq`), production fills (`source=kalshi_parlay_fill`),
      and settlement 0/1 rows (`source=kalshi_settlement`).
    - **How it loads:** ingestion is **automated** — the loader's
      `kalshi-markets-hourly` Durable Object job (hourly cadence) and
      `kalshi-parlay-executor` (5 min) publish through the Cloudflare
      Pipelines stream `cboe_kalshi_markets_v2` into the R2 Data Catalog /
      Iceberg lake. Notebooks only **read** the lake; opening or running
      a notebook never fetches from Kalshi or writes lake rows. The
      hourly-cadence cell below proves it: snapshot timestamps keep
      advancing in one-hour buckets whether or not any notebook runs.
    """)
    return


@app.cell
def _(mo, secret_presence):
    presence = secret_presence()
    _lines = "\n".join(
        f"- `{name}`: {'set' if ok else 'missing'}" for name, ok in presence.items()
    )
    mo.md(f"## Secret presence\n\n{_lines}")
    return


@app.cell
def _(attach_lake, connect, mo):
    try:
        conn = connect()
    except Exception:
        # Both .cache sidecars (kalshi.duckdb, kalshi-session.duckdb) are locked
        # by other notebook kernels. This audit only reads the lake, so attach
        # Iceberg on an in-memory DuckDB instead of waiting for a file lock.
        import duckdb

        conn = duckdb.connect()
    lake_status = attach_lake(conn)
    _ok = lake_status.get("ok")
    _detail = lake_status.get("alias") if _ok else lake_status.get("error")
    mo.md(
        f"""
        ## Iceberg attach

        Warehouse: `lake.options.kalshi_markets` (Pipelines
        `cboe_kalshi_markets_v2`). Status: **{"attached" if _ok else "failed"}** — `{_detail}`
        """
    )
    return conn, lake_status


@app.cell
def _(conn, lake_status, mo):
    if lake_status.get("ok"):
        schema_probe = mo.sql(
            "DESCRIBE lake.options.kalshi_markets",
            engine=conn,
        )
    else:
        schema_probe = None
        mo.md("Lake attach failed — cannot describe the table.")
    schema_probe
    return


@app.cell
def _(conn, lake_status, mo):
    if lake_status.get("ok"):
        source_inventory = mo.sql(
            """
            SELECT source, theme,
                   COUNT(*) AS rows,
                   COUNT(DISTINCT market_ticker) AS distinct_tickers,
                   MIN(fetched_at) AS earliest,
                   MAX(fetched_at) AS latest
            FROM lake.options.kalshi_markets
            GROUP BY source, theme
            ORDER BY rows DESC
            """,
            engine=conn,
        )
    else:
        source_inventory = None
        mo.md("Lake attach failed — skip source inventory.")
    source_inventory
    return


@app.cell
def _(conn, lake_status, mo):
    if lake_status.get("ok"):
        parlay_universe = mo.sql(
            """
            SELECT
              COUNT(*) AS sports_rows,
              COUNT(DISTINCT market_ticker) AS sports_tickers,
              COUNT(DISTINCT CASE WHEN category LIKE 'mve|%' THEN market_ticker END) AS two_leg_combos,
              COUNT(DISTINCT CASE WHEN COALESCE(category, '') NOT LIKE 'mve|%' THEN market_ticker END) AS legs_or_null_category,
              MIN(fetched_at) AS earliest,
              MAX(fetched_at) AS latest
            FROM lake.options.kalshi_markets
            WHERE theme = 'sports'
            """,
            engine=conn,
        )
    else:
        parlay_universe = None
        mo.md("Lake attach failed — skip parlay universe.")
    parlay_universe
    return


@app.cell
def _(conn, lake_status, mo):
    if lake_status.get("ok"):
        status_breakdown = mo.sql(
            """
            SELECT status, market_type, COUNT(*) AS rows,
                   COUNT(DISTINCT market_ticker) AS tickers
            FROM lake.options.kalshi_markets
            WHERE theme = 'sports'
            GROUP BY status, market_type
            ORDER BY rows DESC
            LIMIT 20
            """,
            engine=conn,
        )
    else:
        status_breakdown = None
        mo.md("Lake attach failed — skip status breakdown.")
    status_breakdown
    return


@app.cell
def _(conn, lake_status, mo):
    if lake_status.get("ok"):
        recency = mo.sql(
            """
            SELECT source,
                   MAX(TRY_CAST(fetched_at AS TIMESTAMP)) AS latest,
                   COUNT(DISTINCT market_ticker) AS tickers,
                   COUNT(*) AS rows
            FROM lake.options.kalshi_markets
            WHERE theme = 'sports'
              AND source IN ('kalshi', 'kalshi_rfq', 'kalshi_parlay_fill', 'kalshi_settlement')
            GROUP BY source
            ORDER BY latest DESC
            """,
            engine=conn,
        )
    else:
        recency = None
        mo.md("Lake attach failed — skip recency.")
    recency
    return


@app.cell
def _(conn, lake_status, mo):
    if lake_status.get("ok"):
        hourly_cadence = mo.sql(
            """
            SELECT date_trunc('hour', TRY_CAST(fetched_at AS TIMESTAMP)) AS hour,
                   COUNT(*) AS snapshot_rows,
                   COUNT(DISTINCT market_ticker) AS tickers
            FROM lake.options.kalshi_markets
            WHERE theme = 'sports'
              AND source = 'kalshi'
              AND TRY_CAST(fetched_at AS TIMESTAMP) >= now() - INTERVAL 48 HOURS
              AND CAST(fetched_at AS VARCHAR) NOT LIKE '%T04:00:00%'
              AND CAST(fetched_at AS VARCHAR) NOT LIKE '% 04:00:00%'
            GROUP BY hour
            ORDER BY hour DESC
            """,
            engine=conn,
        )
    else:
        hourly_cadence = None
        mo.md("Lake attach failed — skip hourly cadence.")
    hourly_cadence
    return


@app.cell
def _(conn, lake_status, mo):
    if lake_status.get("ok"):
        sample_combos = mo.sql(
            """
            SELECT market_ticker, category, status, yes_bid, yes_ask,
                   volume_24h, close_time, fetched_at
            FROM lake.options.kalshi_markets
            WHERE theme = 'sports'
              AND category LIKE 'mve|%'
            ORDER BY TRY_CAST(fetched_at AS TIMESTAMP) DESC
            LIMIT 10
            """,
            engine=conn,
        )
    else:
        sample_combos = None
        mo.md("Lake attach failed — skip sample combos.")
    sample_combos
    return


@app.cell
def _(conn, lake_status, mo):
    if lake_status.get("ok"):
        sample_quotes = mo.sql(
            """
            SELECT market_ticker, source, status, yes_bid, yes_ask,
                   close_time, fetched_at
            FROM lake.options.kalshi_markets
            WHERE theme = 'sports'
              AND source IN ('kalshi_rfq', 'kalshi_parlay_fill', 'kalshi_settlement')
            ORDER BY TRY_CAST(fetched_at AS TIMESTAMP) DESC
            LIMIT 10
            """,
            engine=conn,
        )
    else:
        sample_quotes = None
        mo.md("Lake attach failed — skip RFQ / fill / settlement sample.")
    sample_quotes
    return


if __name__ == "__main__":
    app.run()
