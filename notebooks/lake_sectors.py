# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "marimo",
#     "altair",
# ]
# ///
"""WASM prototype: pull a thin slice from the lobster lake API and chart it.

Static islands HTML lives at frontend/public/notebooks/lake-sectors/ (CDN
runtime). Python runs in the browser via Pyodide — the Worker only serves /api/*.
"""

import marimo

__generated_with = "0.24.0"
app = marimo.App(width="medium", app_title="Lake sectors · marimo WASM")


@app.cell
def _():
    import json

    import altair as alt
    import marimo as mo

    return alt, json, mo


@app.cell
def _(mo):
    mo.md(
        r"""
# Lake sectors (WASM)

Runs entirely in your browser via **marimo + Pyodide**. It fetches live JSON from
the screener Worker (`/api/sectors` + a small `/api/query`) and charts it with Altair —
no Python backend for the notebook itself.
"""
    )
    return


@app.cell
def _():
    def resolve_api_base() -> str:
        """Match how the Vite app picks prod vs dev Worker URLs."""
        try:
            from js import window  # type: ignore[attr-defined]

            host = str(window.location.hostname).lower()
        except Exception:
            return "https://api-dev.lobster.mp"

        if host in ("localhost", "127.0.0.1"):
            # Vite proxies /api → local Worker when serving the SPA; the notebook
            # asset path is same-origin so relative /api works too.
            return ""
        if (
            host == "robs-options-slop-dev.pages.dev"
            or host.endswith(".robs-options-slop-dev.pages.dev")
            or host == "dev.lobster.mp"
            or host.startswith("api-dev.")
        ):
            return "https://api-dev.lobster.mp"
        return "https://api.lobster.mp"

    API_BASE = resolve_api_base()
    return (API_BASE,)


@app.cell
async def _(API_BASE, json, mo):
    from pyodide.http import pyfetch

    async def api_get(path: str):
        url = f"{API_BASE}{path}"
        r = await pyfetch(url)
        if r.status >= 400:
            text = await r.text()
            raise RuntimeError(f"GET {path} → {r.status}: {text[:240]}")
        return await r.json()

    async def api_query(sql: str, limit: int = 50):
        url = f"{API_BASE}/api/query"
        r = await pyfetch(
            url,
            method="POST",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"sql": sql, "limit": limit}),
        )
        if r.status >= 400:
            text = await r.text()
            raise RuntimeError(f"POST /api/query → {r.status}: {text[:240]}")
        return await r.json()

    with mo.status.spinner(title="Loading /api/sectors…"):
        sectors = await api_get("/api/sectors")

    mo.md(f"API base: `{API_BASE or '(same origin)'}` · **{len(sectors)}** sectors")
    return api_get, api_query, sectors


@app.cell
def _(alt, sectors):
    sorted_sectors = sorted(sectors, key=lambda r: int(r["symbols"]), reverse=True)
    chart = (
        alt.Chart(sorted_sectors)
        .mark_bar()
        .encode(
            x=alt.X("symbols:Q", title="Underlyings (latest snapshot)"),
            y=alt.Y("sector:N", sort="-x", title=None),
            tooltip=["sector", "symbols", alt.Tooltip("avg_spot:Q", format=".2f")],
        )
        .properties(height=420, title="Symbols per sector")
    )
    chart
    return chart, sorted_sectors


@app.cell
async def _(api_query, mo):
    sql = """
    SELECT ticker AS symbol, name, sector, spot_price
    FROM options.underlying_snapshots
    WHERE sector = 'Information Technology'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY fetched_at DESC) = 1
    ORDER BY spot_price DESC NULLS LAST
    LIMIT 15
    """
    with mo.status.spinner(title="Running lake SQL…"):
        result = await api_query(sql, limit=15)

    rows = result.get("rows") or []
    mo.md("### Top IT underlyings by spot (live `/api/query`)")
    rows
    return result, rows, sql


@app.cell
def _(mo, sql):
    mo.accordion({"SQL used": mo.md(f"```sql\n{sql.strip()}\n```")})
    return


if __name__ == "__main__":
    app.run()
