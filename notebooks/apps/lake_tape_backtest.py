import marimo

__generated_with = "0.24.2"
app = marimo.App(width="full")


@app.cell
def _():
    import marimo as mo
    import polars as pl

    from lobster_nb.env import load_repo_env, secret_presence
    from lobster_nb.kalshi import get_json, ping
    from lobster_nb.lake import attach_lake, connect
    from lobster_nb.parlay import BOOK_LONGSHOT, PRODUCTION_KNOBS, self_check
    from lobster_nb.parlay_backtest import (
        COVERAGE_HOURLY_SQL,
        PROBE_SERIES_SQL,
        backtest_parlay_books,
        coverage_over_time,
        hydrate_settlements,
        lake_score_table,
        load_lake_tape,
        sep15_buy_no_fills,
        source_mix,
        tape_self_check,
    )

    _ = load_repo_env()
    return (
        BOOK_LONGSHOT,
        COVERAGE_HOURLY_SQL,
        PRODUCTION_KNOBS,
        PROBE_SERIES_SQL,
        attach_lake,
        backtest_parlay_books,
        connect,
        coverage_over_time,
        get_json,
        hydrate_settlements,
        lake_score_table,
        load_lake_tape,
        mo,
        ping,
        pl,
        secret_presence,
        self_check,
        sep15_buy_no_fills,
        source_mix,
        tape_self_check,
    )


@app.cell
def _(mo, secret_presence):
    presence = secret_presence()
    _lines = "\n".join(
        f"- `{name}`: {'set' if ok else 'missing'}" for name, ok in presence.items()
    )
    mo.md(
        f"""
        # Kalshi sports tape (Iceberg only)

        Backtest the listed **two-leg sports** universe in
        `lake.options.kalshi_markets`. Cold start is git + root `.env`.
        Local DuckDB `.cache` is a session memo, not a warehouse — an empty
        cache is correct on a new machine.

        This is **not** `parlay_strategies.py`. That notebook scores the live
        CLOB. This one never scrapes Get Markets, never fetches 1m candles,
        never creates or accepts an RFQ, and never sets `KALSHI_PARLAY_LIVE=1`.
        Do not `CREATE`/`INSERT` on `lake.*`.

        **Universe:** `theme='sports'` and `category LIKE 'mve|%'` and
        `series_ticker LIKE 'KXMVE%'`. Combo series is `KXMVECROSSCATEGORY`,
        not the ingest id `KXMVE`. n>2 stacks and crypto-only CROSSCATEGORY
        are not the listed tape. Empty **0/0 CLOB** rows are valid history.

        **Split:** `source=kalshi` hourly snapshots vs daily candles
        (`fetched_at` often `T04:00:00Z`). Grade `kalshi_rfq` /
        `kalshi_parlay_fill` with **later** `kalshi_settlement` only.

        **Production book:** `cross_game_longshot` (ask ≤ 1/35 and ≤ independence).

        ## Secret presence

        {_lines}
        """
    )
    return


@app.cell
def _(attach_lake, connect, mo):
    conn = connect()
    lake_status = attach_lake(conn)
    _ok = lake_status.get("ok")
    _detail = lake_status.get("alias") if _ok else lake_status.get("error")
    mo.md(
        f"""
        ## Iceberg attach

        Warehouse: `lake.options.kalshi_markets` (Pipelines `cboe_kalshi_markets_v2`).
        Status: **{"attached" if _ok else "failed"}** — `{_detail}`
        """
    )
    return conn, lake_status


@app.cell
def _(mo, ping, self_check, tape_self_check):
    port_errors = self_check()
    tape_errors = tape_self_check()
    kalshi_status = ping()
    _port = "ok" if not port_errors else "; ".join(port_errors)
    _tape = "ok" if not tape_errors else "; ".join(tape_errors)
    mo.md(
        f"""
        ## Port check + optional signed GET

        Filter port: **{_port}**. Tape helpers: **{_tape}**.

        `GET /exchange/status` is optional (hydrate missing settlements the
        same way). HTTP **{kalshi_status.get("status", "n/a")}**
        (signed={kalshi_status.get("signed")}, ok={kalshi_status.get("ok")})
        {"" if kalshi_status.get("ok") else "— " + str(kalshi_status.get("error") or "")}
        """
    )
    return


@app.cell
def _(PROBE_SERIES_SQL, conn, lake_status, mo):
    if lake_status.get("ok"):
        series_probe = mo.sql(PROBE_SERIES_SQL, engine=conn)
    else:
        series_probe = None
        mo.md("Lake attach failed — skip series probe.")
    series_probe
    return


@app.cell
def _(COVERAGE_HOURLY_SQL, conn, lake_status, mo):
    if lake_status.get("ok"):
        coverage_sql = mo.sql(COVERAGE_HOURLY_SQL, engine=conn)
    else:
        coverage_sql = None
        mo.md("Lake attach failed — skip hourly coverage SQL.")
    coverage_sql
    return


@app.cell
def _(conn, lake_status, load_lake_tape, mo):
    lake_notes: list[str] = []
    lake_markets: list[dict] = []
    if lake_status.get("ok"):
        lake_markets, lake_notes = load_lake_tape(conn)
    else:
        lake_notes.append("Lake attach failed.")
    mo.md("### Lake load\n\n" + "\n\n".join(f"- {n}" for n in lake_notes))
    return (lake_markets,)


@app.cell
def _(coverage_over_time, lake_markets: list[dict], mo, pl, source_mix):
    coverage_hours, coverage_days, coverage_summary = coverage_over_time(lake_markets)
    mix = pl.DataFrame(source_mix(lake_markets)) if lake_markets else pl.DataFrame()
    hours_df = pl.DataFrame(coverage_hours) if coverage_hours else pl.DataFrame()
    days_df = pl.DataFrame(coverage_days) if coverage_days else pl.DataFrame()
    _recent = coverage_summary.get("recent_hours_gte_80")
    _recent_n = coverage_summary.get("recent_hours")
    mo.vstack(
        [
            mo.md(
                "### Coverage over time\n\n"
                "Python table = parsed two-leg sports (n>2 and crypto-only dropped; "
                "empty 0/0 CLOB kept). The SQL cell above is the raw "
                "`source=kalshi` scan before that parse. Daily candles at "
                "`T04:00:00Z` are excluded from both. "
                f"Max two-leg count in a hour: **{coverage_summary.get('max_two_leg')}**. "
                f"After {coverage_summary.get('listed_universe_since')} "
                f"(uncapped listed universe): **{_recent} / {_recent_n}** hours "
                "have ≥ 80 two-leg tickers (often true after that ingest). "
                f"Skipped n>2={coverage_summary.get('skipped_n3')}, "
                f"crypto-only={coverage_summary.get('skipped_crypto')}, "
                f"empty-CLOB rows={coverage_summary.get('empty_clob_rows')}."
            ),
            mo.md("#### Row kind (hourly vs candle vs tape)"),
            mo.ui.table(mix, selection=None) if mix.height else mo.md("_No rows._"),
            mo.md("#### Daily max two-leg count"),
            mo.ui.table(days_df, selection=None) if days_df.height else mo.md("_No hourly listed snapshots._"),
            mo.md("#### Hourly two-leg count"),
            mo.ui.table(hours_df, selection=None) if hours_df.height else mo.md("_No hourly listed snapshots._"),
        ]
    )
    return


@app.cell
def _(mo):
    hydrate_missing = mo.ui.run_button(label="Hydrate missing settlements (signed GET only)")
    mo.vstack(
        [
            mo.md(
                "Optional: fill tickers that have an RFQ or fill but no later "
                "`kalshi_settlement` row. Results stay in this session — not Iceberg."
            ),
            hydrate_missing,
        ]
    )
    return (hydrate_missing,)


@app.cell
def _(get_json, hydrate_missing, hydrate_settlements, lake_markets: list[dict], mo):
    graded_markets = list(lake_markets)
    hydrate_note = "Hydrate skipped (button off)."
    if hydrate_missing.value:
        _extra, _fetched = hydrate_settlements(graded_markets, get_json, max_tickers=40)
        if _fetched:
            graded_markets = [*graded_markets, *_extra]
            hydrate_note = (
                f"Hydrated {_fetched} missing settlements from live GET "
                "(not written to Iceberg)."
            )
        else:
            hydrate_note = "Hydrate ran — no extra settlement rows."
    mo.md(f"### Settlement hydrate\n\n{hydrate_note}")
    return (graded_markets,)


@app.cell
def _(PRODUCTION_KNOBS, backtest_parlay_books, graded_markets: list[dict]):
    lake_bt = backtest_parlay_books(graded_markets, PRODUCTION_KNOBS)
    lake_bt
    return (lake_bt,)


@app.cell
def _(BOOK_LONGSHOT, PRODUCTION_KNOBS, lake_bt, lake_score_table, mo, pl):
    lake_scores = pl.DataFrame(lake_score_table(lake_bt, PRODUCTION_KNOBS))
    _prod = [
        r
        for r in lake_scores.to_dicts()
        if r["book"] == BOOK_LONGSHOT and r["game_slice"] == "cross_game"
    ]
    _prod_row = _prod[0] if _prod else {}
    _accepts = [
        {
            "book": book,
            "market_ticker": row.market_ticker,
            "game": row.game_group,
            "sides": "/".join(row.sides),
            "p": row.p,
            "q": row.q,
            "yes_bid": row.yes_bid,
            "yes_ask": row.yes_ask,
            "settlement": row.settlement,
            "yes_pnl": row.yes_pnl,
            "no_pnl": row.no_pnl,
            "reasons": ",".join(row.books[book].reasons),
        }
        for row in lake_bt.scored
        for book in row.books
        if row.books[book].ok
    ]
    lake_accepts = pl.DataFrame(_accepts) if _accepts else pl.DataFrame()
    mo.vstack(
        [
            mo.md(
                "### RFQ book scores\n\n"
                f"Aligned two-leg sports RFQs: **{lake_bt.aligned}** "
                f"(tickers with RFQ={lake_bt.rfq_tickers}, snapshots={lake_bt.rfq_snapshots}). "
                "ev_yes = BUY YES at the RFQ ask minus taker fees; "
                "ev_actual = BUY NO at `1 − yes_bid`. Production book is "
                f"**`{BOOK_LONGSHOT}`** on the cross-game slice: "
                f"would-accept={_prod_row.get('would_accept')}, "
                f"settled={_prod_row.get('settled')}, "
                f"hit_rate={_prod_row.get('hit_rate')}, "
                f"ev_yes={_prod_row.get('ev_yes')}, "
                f"ev_actual={_prod_row.get('ev_actual')}."
            ),
            mo.ui.table(lake_scores, selection=None),
            mo.md("#### Would-accept tickets"),
            mo.ui.table(lake_accepts, selection=None)
            if lake_accepts.height
            else mo.md("_No would-accept tickets._"),
            mo.md("\n".join(f"- {n}" for n in lake_bt.notes)),
        ]
    )
    return


@app.cell
def _(lake_bt, mo, pl, sep15_buy_no_fills):
    _all_fills = [
        {
            "market_ticker": f.market_ticker,
            "title": f.title,
            "fill_side": f.fill_side,
            "contracts": f.contracts,
            "yes_price": f.yes_price,
            "no_price": f.no_price,
            "fee": f.fee,
            "settlement": f.settlement,
            "actual_pnl": f.actual_pnl,
            "yes_counterfactual_pnl": f.yes_counterfactual_pnl,
            "quoted_at": f.quoted_at,
        }
        for f in lake_bt.live.fills
    ]
    _cohort = sep15_buy_no_fills(lake_bt.live)
    _cohort_rows = [
        {
            "market_ticker": f.market_ticker,
            "title": f.title,
            "fill_side": f.fill_side,
            "contracts": f.contracts,
            "yes_price": f.yes_price,
            "no_price": f.no_price,
            "fee": f.fee,
            "settlement": f.settlement,
            "actual_pnl": f.actual_pnl,
            "yes_counterfactual_pnl": f.yes_counterfactual_pnl,
            "quoted_at": f.quoted_at,
        }
        for f in _cohort
    ]
    fill_table = pl.DataFrame(_all_fills) if _all_fills else pl.DataFrame()
    cohort_table = pl.DataFrame(_cohort_rows) if _cohort_rows else pl.DataFrame()
    _cohort_pnl = sum(f.actual_pnl or 0 for f in _cohort)
    _cohort_yes = sum(f.yes_counterfactual_pnl or 0 for f in _cohort)
    _cohort_settled = sum(1 for f in _cohort if f.settlement in (0, 1))
    mo.vstack(
        [
            mo.md(
                "### Sep 15 BUY NO fill cohort\n\n"
                "Production accepts with `accepted_side=yes` filled **BUY NO** "
                "(cost ≈ `1 − yes_bid`) on 2026-09-14 evening through "
                "2026-09-15 UTC. Graded only with later `kalshi_settlement`. "
                f"Cohort n=**{len(_cohort)}**, settled={_cohort_settled}, "
                f"actual P&L={round(_cohort_pnl, 4)}, "
                f"YES-at-same-price={round(_cohort_yes, 4)}. "
                f"All `kalshi_parlay_fill` rows: n={lake_bt.live.n}, "
                f"settled={lake_bt.live.settled}, hit_rate={lake_bt.live.hit_rate}."
            ),
            mo.ui.table(cohort_table, selection=None)
            if cohort_table.height
            else mo.md("_No Sep 15 BUY NO fills in the lake yet._"),
            mo.md("#### All lake fills"),
            mo.ui.table(fill_table, selection=None)
            if fill_table.height
            else mo.md("_No `kalshi_parlay_fill` rows._"),
        ]
    )
    return


@app.cell
def _(BOOK_LONGSHOT, lake_bt, mo):
    mo.md(
        f"""
        ## Summary

        Iceberg tape only. Production book `{BOOK_LONGSHOT}`.
        Aligned RFQs **{lake_bt.aligned}**. Live fills **{lake_bt.live.n}**
        (settled {lake_bt.live.settled}). Do not dump this DuckDB session
        into the lake, and do not turn LIVE on from here.
        """
    )
    return


if __name__ == "__main__":
    app.run()
