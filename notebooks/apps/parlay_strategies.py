import marimo

__generated_with = "0.24.2"
app = marimo.App(width="full")


@app.cell
def _():
    import uuid
    from datetime import datetime, timezone

    import marimo as mo
    import polars as pl

    from lobster_nb.env import load_repo_env, secret_presence
    from lobster_nb.kalshi import (
        cache_live_candles,
        cache_live_tape,
        fetch_candlesticks,
        get_json,
        load_cached_candles,
        load_cached_live_tape,
        ping,
        pull_open_two_leg_sports,
    )
    from lobster_nb.lake import attach_lake, connect
    from lobster_nb.mve import parse_mve_category
    from lobster_nb.parlay import BOOKS, ParlayKnobs, self_check
    from lobster_nb.parlay_backtest import (
        PROBE_SQL,
        backtest_parlay_books,
        hydrate_settlements,
        lake_score_table,
        live_book_summary,
        load_lake_sports_tape,
        perturbation_table,
        record_strategy_runs,
        score_live_combos,
    )

    load_repo_env()
    return (
        BOOKS,
        PROBE_SQL,
        ParlayKnobs,
        attach_lake,
        backtest_parlay_books,
        cache_live_candles,
        cache_live_tape,
        fetch_candlesticks,
        get_json,
        hydrate_settlements,
        lake_score_table,
        live_book_summary,
        load_cached_candles,
        load_cached_live_tape,
        load_lake_sports_tape,
        mo,
        parse_mve_category,
        perturbation_table,
        ping,
        pl,
        pull_open_two_leg_sports,
        record_strategy_runs,
        secret_presence,
        self_check,
        uuid,
    )


@app.cell
def _(mo, secret_presence):
    presence = secret_presence()
    _lines = "\n".join(
        f"- `{name}`: {'set' if ok else 'missing'}" for name, ok in presence.items()
    )
    mo.md(
        f"""
        # Kalshi sports parlay books

        Score the three executable books against **two tapes**: the Iceberg lake
        (RFQ two-ways + settlements + fills) and live Kalshi CLOB (signed GET,
        no RFQ, no orders).

        Books (ported from `loader/src/kalshi-parlay-filter.ts`):

        1. `corr_room_yes` — same-game; Fréchet room ≥ 15¢; ask ≤ p×q + 2¢; |φ| < 0.15
        2. `same_game_underdog` — same-game same-side; ask ≤ 50¢ (executor default)
        3. `cross_game_longshot` — cross-game; ask ≤ 1/35 and ≤ independence

        Knobs default to production constants. Change one at a time — the comparison
        cell already does that. Universe is two-leg **sports** MVEs only.

        **Do not trade.** This notebook never creates or accepts an RFQ.

        ## Secret presence

        {_lines}
        """
    )
    return


@app.cell
def _(attach_lake, mo):
    import duckdb as _duckdb

    _db_path = __import__("lobster_nb.lake", fromlist=["cache_path"]).cache_path()
    try:
        conn = _duckdb.connect(str(_db_path))
    except Exception:
        _db_path = _db_path.with_name("kalshi-session.duckdb")
        conn = _duckdb.connect(str(_db_path))
    lake_status = attach_lake(conn)
    _ok = lake_status.get("ok")
    _detail = lake_status.get("alias") if _ok else lake_status.get("error")
    mo.md(
        f"""
        ## Iceberg attach

        Local DuckDB: `{_db_path}` (gitignored session memo, not a warehouse).
        Query `lake.options.*` read-only. Empty `.cache` is correct on a new
        machine — historical RFQ / settlement / fill live in Iceberg.
        Writes stay on local tables (`strategy_runs`, `live_markets`).

        Status: **{"attached" if _ok else "failed"}** -- `{_detail}`
        """
    )

    return conn, lake_status


@app.cell
def _(mo, ping, self_check):
    kalshi_status = ping()
    port_errors = self_check()
    _port = "port fixtures ok" if not port_errors else "port fixture errors: " + "; ".join(port_errors)
    mo.md(
        f"""
        ## Kalshi signed GET + port check

        `GET /exchange/status` → HTTP **{kalshi_status.get('status', 'n/a')}**
        (signed={kalshi_status.get('signed')}, ok={kalshi_status.get('ok')})
        {'' if kalshi_status.get('ok') else '— ' + str(kalshi_status.get('error') or '')}

        Filter port: **{_port}**
        """
    )
    return


@app.cell
def _(mo):
    corr_room_floor = mo.ui.number(
        start=0, stop=0.5, value=0.15, step=0.01, label="corr_room floor"
    )
    max_ask_over_indep = mo.ui.number(
        start=0, stop=0.2, value=0.02, step=0.01, label="max ask over indep"
    )
    max_abs_phi = mo.ui.number(
        start=0, stop=0.5, value=0.15, step=0.01, label="max |φ|"
    )
    underdog_max_cost = mo.ui.number(
        start=0.05, stop=0.95, value=0.50, step=0.01, label="underdog max cost"
    )
    longshot_multiple = mo.ui.number(
        start=5, stop=80, value=35, step=1, label="longshot multiple"
    )
    max_spread = mo.ui.number(
        start=0.01, stop=0.25, value=0.08, step=0.01, label="max spread"
    )
    persist_n_minutes = mo.ui.number(
        start=0, stop=30, value=0, step=1, label="persist N minutes (1m cache)"
    )
    refresh_live = mo.ui.run_button(label="Refresh live tape (GET only)")
    mo.vstack(
        [
            mo.md("## Knobs (production defaults)"),
            mo.hstack(
                [corr_room_floor, max_ask_over_indep, max_abs_phi, underdog_max_cost],
                justify="start",
                wrap=True,
            ),
            mo.hstack(
                [longshot_multiple, max_spread, persist_n_minutes, refresh_live],
                justify="start",
                wrap=True,
            ),
        ]
    )
    return (
        corr_room_floor,
        longshot_multiple,
        max_abs_phi,
        max_ask_over_indep,
        max_spread,
        persist_n_minutes,
        refresh_live,
        underdog_max_cost,
    )


@app.cell
def _(
    ParlayKnobs,
    corr_room_floor,
    longshot_multiple,
    max_abs_phi,
    max_ask_over_indep,
    max_spread,
    persist_n_minutes,
    underdog_max_cost,
):
    knobs = ParlayKnobs(
        corr_room_floor=float(corr_room_floor.value),
        max_ask_over_indep=float(max_ask_over_indep.value),
        max_abs_phi=float(max_abs_phi.value),
        underdog_max_cost=float(underdog_max_cost.value),
        longshot_multiple=float(longshot_multiple.value),
        max_spread=float(max_spread.value),
        persist_n_minutes=int(persist_n_minutes.value),
        contracts=10,
    )
    knobs
    return (knobs,)


@app.cell
def _(PROBE_SQL, conn, lake_status, mo):
    if lake_status.get("ok"):
        probe = mo.sql(PROBE_SQL, engine=conn)
    else:
        probe = None
        mo.md("Lake attach failed — skip probe.")
    probe
    return


@app.cell
def _(
    conn,
    get_json,
    hydrate_settlements,
    lake_status,
    load_lake_sports_tape,
    mo,
):
    lake_notes: list[str] = []
    lake_markets: list[dict] = []
    if lake_status.get("ok"):
        lake_markets, lake_notes = load_lake_sports_tape(conn)
        _extra, _fetched = hydrate_settlements(lake_markets, get_json, max_tickers=40)
        if _fetched:
            lake_markets = [*lake_markets, *_extra]
            lake_notes.append(f"Hydrated {_fetched} missing settlements from live GET (not written to Iceberg).")
    else:
        lake_notes.append("Lake attach failed.")
    mo.md("### Lake load\n\n" + "\n\n".join(f"- {n}" for n in lake_notes))
    return (lake_markets,)


@app.cell
def _(backtest_parlay_books, knobs, lake_markets: list[dict]):
    lake_bt = backtest_parlay_books(lake_markets, knobs)
    lake_bt
    return (lake_bt,)


@app.cell
def _(knobs, lake_bt, lake_score_table, mo, pl):
    lake_scores = pl.DataFrame(lake_score_table(lake_bt, knobs))
    _fill_rows = [
        {
            "market_ticker": f.market_ticker,
            "fill_side": f.fill_side,
            "contracts": f.contracts,
            "yes_price": f.yes_price,
            "no_price": f.no_price,
            "settlement": f.settlement,
            "actual_pnl": f.actual_pnl,
            "yes_counterfactual_pnl": f.yes_counterfactual_pnl,
            "quoted_at": f.quoted_at,
        }
        for f in lake_bt.live.fills
    ]
    live_fill_table = pl.DataFrame(_fill_rows) if _fill_rows else pl.DataFrame()
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
                "### Lake RFQ score\n\n"
                f"aligned two-leg sports RFQs: **{lake_bt.aligned}** "
                f"(tickers with RFQ={lake_bt.rfq_tickers}, snapshots={lake_bt.rfq_snapshots}). "
                "ev_yes = BUY YES at ask; ev_actual = BUY NO at `1 − yes_bid` "
                "(2026-09-14 production fill side). `n` is aligned quotes in that slice; "
                "would-accept is the book filter."
            ),
            mo.ui.table(lake_scores, selection=None),
            mo.md("#### Would-accept tickets (lake RFQ)"),
            mo.ui.table(lake_accepts, selection=None) if lake_accepts.height else mo.md("_No would-accept tickets._"),
            mo.md(
                f"#### Actual fills (`kalshi_parlay_fill`) — n={lake_bt.live.n}, "
                f"settled={lake_bt.live.settled}, hit_rate={lake_bt.live.hit_rate}, "
                f"actual={lake_bt.live.actual_pnl}, yes-at-ask={lake_bt.live.yes_counterfactual_pnl}"
            ),
            mo.ui.table(live_fill_table, selection=None) if live_fill_table.height else mo.md("_No fill rows._"),
            mo.md("\n".join(f"- {n}" for n in lake_bt.notes)),
        ]
    )
    return (lake_scores,)


@app.cell
def _(lake_markets: list[dict], mo, perturbation_table, pl):
    perturbs = pl.DataFrame(perturbation_table(lake_markets))
    mo.vstack(
        [
            mo.md(
                "### Production vs one perturbation at a time\n\n"
                "Not a grid search. Each row changes **one** production constant. "
                "`delta_accept` / `delta_ev_yes` are versus production knobs on the same tape. "
                "Call out sample size: if `n` is small, ignore the sign of EV."
            ),
            mo.ui.table(perturbs, selection=None),
        ]
    )
    return


@app.cell
def _(
    cache_live_tape,
    conn,
    load_cached_live_tape,
    mo,
    pull_open_two_leg_sports,
    refresh_live,
):
    _cached = load_cached_live_tape(conn)
    if refresh_live.value or _cached is None:
        live_pack = pull_open_two_leg_sports(max_combos=200, max_pages=5)
        if live_pack.get("combos"):
            cache_live_tape(conn, live_pack)
        live_source = "fresh GET"
    else:
        live_pack = _cached
        live_source = "local cache"
    mo.md(
        f"""
        ## Live tape

        Source: **{live_source}** at `{live_pack.get('pulled_at')}` —
        scanned={live_pack.get('scanned')} pages={live_pack.get('pages')}
        combos={len(live_pack.get('combos') or [])}
        legs={len(live_pack.get('legs') or [])}
        crypto_skipped={live_pack.get('crypto_skipped')}
        ok={live_pack.get('ok')} {live_pack.get('error') or ''}

        Open MVE `GET /markets?mve_filter=only&status=open`, then legs via
        `GET /markets?tickers=…`. Cached in local DuckDB, not Iceberg.
        """
    )
    return live_pack, live_source


@app.cell
def _(
    cache_live_candles,
    conn,
    fetch_candlesticks,
    knobs,
    live_pack,
    load_cached_candles,
    mo,
    parse_mve_category,
):
    candles_by_ticker = load_cached_candles(conn)
    _n = int(knobs.persist_n_minutes)
    if _n > 0 and not candles_by_ticker:
        _tickers = []
        for _combo in live_pack.get("combos") or []:
            _parsed = parse_mve_category(_combo.get("category"))
            if _parsed:
                _tickers.append(_combo["market_ticker"])
        _tickers = _tickers[:40]
        _candles = fetch_candlesticks(_tickers, period_interval=1)
        if _candles:
            cache_live_candles(conn, _candles)
            candles_by_ticker = load_cached_candles(conn)
        candle_note = f"Fetched {len(_candles)} 1m candles for {len(_tickers)} combos."
    else:
        candle_note = (
            f"1m cache tickers={len(candles_by_ticker)}"
            if candles_by_ticker
            else "persist-N off (no 1m fetch)."
        )
    mo.md(f"1m candles: {candle_note}")
    return (candles_by_ticker,)


@app.cell
def _(candles_by_ticker, knobs, live_pack):
    import importlib
    import lobster_nb.parlay_backtest as _pbt

    importlib.reload(_pbt)
    live_rows, live_notes = _pbt.score_live_combos(
        live_pack.get("combos") or [],
        live_pack.get("legs_by_ticker") or {},
        knobs,
        candles_by_ticker,
    )

    return live_notes, live_rows


@app.cell
def _(knobs, live_book_summary, live_notes, live_rows, mo, pl):
    live_scores = pl.DataFrame(live_book_summary(live_rows, knobs))
    live_detail = pl.DataFrame(live_rows) if live_rows else pl.DataFrame()
    _buys = [r for r in live_rows if r["action"] == "buy_yes"]
    live_buys = pl.DataFrame(_buys) if _buys else pl.DataFrame()
    _seen: set[str] = set()
    _inv = []
    for _r in live_rows:
        _t = _r["market_ticker"]
        if _t in _seen:
            continue
        _seen.add(_t)
        _inv.append(
            {
                "market_ticker": _t,
                "title": _r["title"],
                "game": _r["game"],
                "sides": _r["sides"],
                "p": _r["p"],
                "q": _r["q"],
                "yes_bid": _r["yes_bid"],
                "yes_ask": _r["yes_ask"],
                "independence": _r["independence"],
                "corr_room": _r["corr_room"],
                "two_sided": _r.get("two_sided"),
            }
        )
    live_inventory = pl.DataFrame(_inv) if _inv else pl.DataFrame()
    mo.vstack(
        [
            mo.md(
                "### Live CLOB screen\n\n"
                "Same three books on the **public two-way**. Two-sided books get "
                "`quote_id=live_clob` (screen only — no RFQ create/accept). "
                "Empty 0/0 or 0/1 books stay in the inventory with `action=skip`. "
                "Live EV is unknown until settlement."
            ),
            mo.ui.table(live_scores, selection=None),
            mo.md("#### Open two-leg sports inventory (legs aligned)"),
            mo.ui.table(live_inventory, selection=None) if live_inventory.height else mo.md("_No aligned two-leg sports combos._"),
            mo.md("#### Would buy YES now"),
            mo.ui.table(live_buys, selection=None) if live_buys.height else mo.md("_Nothing clears the live filter (no two-sided CLOB, or gates failed)._"),
            mo.md("#### Per-book live rows"),
            mo.ui.table(live_detail, selection=None) if live_detail.height else mo.md("_No live rows._"),
            mo.md("\n".join(f"- {n}" for n in live_notes)),
        ]
    )

    return live_buys, live_scores


@app.cell
def _(
    conn,
    knobs,
    lake_bt,
    lake_scores,
    live_notes,
    live_scores,
    record_strategy_runs,
    uuid,
):
    run_id = uuid.uuid4().hex[:12]
    record_strategy_runs(
        conn,
        run_id,
        "lake",
        knobs,
        lake_scores.to_dicts(),
        " | ".join(lake_bt.notes)[:500],
    )
    record_strategy_runs(
        conn,
        run_id,
        "live",
        knobs,
        live_scores.to_dicts(),
        " | ".join(live_notes)[:500],
    )
    run_id
    return (run_id,)


@app.cell
def _(
    BOOKS,
    knobs,
    lake_bt,
    lake_scores,
    live_buys,
    live_pack,
    live_scores,
    live_source,
    mo,
    run_id,
):
    def _best_lake():
        rows = [
            r
            for r in lake_scores.to_dicts()
            if r["game_slice"] == "all" and r["book"] in BOOKS
        ]
        scored = [r for r in rows if (r.get("settled") or 0) > 0]
        pool = scored or rows
        if not pool:
            return None
        return max(pool, key=lambda r: (r.get("ev_yes") is not None, r.get("ev_yes") or 0, r.get("would_accept") or 0))

    def _best_live():
        rows = [r for r in live_scores.to_dicts() if r["game_slice"] == "all"]
        if not rows:
            return None
        return max(rows, key=lambda r: r.get("would_accept") or 0)

    _lake_best = _best_lake()
    _live_best = _best_live()
    _thin = lake_bt.rfq_tickers < 30
    _live_n = len(live_pack.get("combos") or [])
    _buy_n = live_buys.height if hasattr(live_buys, "height") else 0
    mo.md(
        f"""
        ## Summary

        Run `{run_id}` · knobs `{knobs.params_json()}`

        **Lake tape** — {lake_bt.aligned} aligned two-leg sports RFQs
        ({lake_bt.rfq_tickers} tickers, {lake_bt.rfq_snapshots} snapshots).
        {'Sample is thin — treat EV as a sketch and use live only as a screen.' if _thin else 'Enough RFQ tickers to compare books, still not a large sample.'}

        - Best lake book by YES-at-ask EV: **{(_lake_best or {}).get('book', 'n/a')}**
          would-accept={(_lake_best or {}).get('would_accept')}
          settled={(_lake_best or {}).get('settled')}
          hit_rate={(_lake_best or {}).get('hit_rate')}
          ev_yes={(_lake_best or {}).get('ev_yes')}
          ev_actual (BUY NO)={(_lake_best or {}).get('ev_actual')}
        - Production fills (`kalshi_parlay_fill`): n={lake_bt.live.n}
          settled={lake_bt.live.settled} actual={lake_bt.live.actual_pnl}
          yes-counterfactual={lake_bt.live.yes_counterfactual_pnl}

        **Live tape** ({live_source}) — {_live_n} open two-leg sports combos scored.
        Live has no settlement yet, so this is a **screen**, not EV.

        - Most would-accept now: **{(_live_best or {}).get('book', 'n/a')}**
          n={(_live_best or {}).get('n')} would-accept={(_live_best or {}).get('would_accept')}
        - Live buy-YES rows: **{_buy_n}**
        """
    )
    return


if __name__ == "__main__":
    app.run()
