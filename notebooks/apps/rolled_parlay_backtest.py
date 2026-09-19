import marimo

__generated_with = "0.24.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import polars as pl
    from datetime import date, datetime, time, timedelta, timezone

    from lobster_nb.kalshi import get_json
    from lobster_nb.lake import attach_lake, connect
    from lobster_nb.parlay_backtest import (
        load_lake_tape,
        load_n_leg_settlements,
        record_n_leg_settlements,
    )
    from lobster_nb.rolled_parlay import (
        build_correlated_3leg_parlays,
        build_correlated_4leg_parlays,
        build_cross_game_parlays,
        build_same_game_parlays,
        grade_parlays,
        hydrate_ticker_settlements,
        leg_universe,
        rolled_vs_listed,
        self_check,
        summarize_parlays,
    )

    return (
        attach_lake,
        build_correlated_3leg_parlays,
        build_correlated_4leg_parlays,
        build_cross_game_parlays,
        build_same_game_parlays,
        connect,
        date,
        datetime,
        get_json,
        grade_parlays,
        hydrate_ticker_settlements,
        leg_universe,
        load_lake_tape,
        load_n_leg_settlements,
        mo,
        pl,
        record_n_leg_settlements,
        rolled_vs_listed,
        self_check,
        summarize_parlays,
        time,
        timedelta,
        timezone,
    )


@app.cell
def _(mo):
    mo.md(r"""
    # Rolled correlated-leg parlay backtest

    Strategy under test: **layer a few correlated legs for a ~30:1 payout
    profile**. A rolled parlay buys leg *i* at its YES ask (plus Kalshi
    taker fee) and rolls all proceeds into the next leg, so $1 risked pays

    $$\text{payout} = \frac{1}{\prod_i (\text{ask}_i + \text{fee}_i)}$$

    if every leg hits. Two legs at ~18¢ net ≈ 27x, three at ~32¢ ≈ 30x,
    four at ~42¢ ≈ 30x.

    **The correlation hypothesis:** same-game legs are correlated, so
    P(all hit) can exceed the independence product ∏ p̂ᵢ (the Fréchet
    room). If the realized joint beats what you pay for it — the ask
    spread at each roll — the parlay is +EV. The **cross-game control**
    (legs from different games, constructed into the same payout band)
    is the independence baseline.

    **Semantic 3-leg template:** naive in-band k-subset enumeration
    mixed in mutually-exclusive legs (opposing scorers, both sides of a
    spread) and graded 0/211. The semantic book instead picks, per game:
    (1) team wins (`KXNFLGAME` moneyline), (2) a player prop on that
    same team (`KXNFLPASSTDS` QB passing TDs / `KXNFLTD` player TDs,
    no D/ST), (3) game total over (`KXNFLTOTAL`) — team wins ⇒ its
    star scored ⇒ the points went up, so all three legs are positively
    correlated by construction.

    **As-of honesty:** quotes are the last hourly lake snapshot at or
    before the as-of time, of markets still open then — no post-close
    quotes, no early settlements (no leakage). Legs are graded with
    later `source=kalshi_settlement` rows; legs the loader never
    enqueued are hydrated by a signed read-only `GET /markets?tickers=`
    into the local session memo (never Iceberg).

    Read-only: no live CLOB, no RFQ create/accept, no writes to
    `lake.*`. LIVE stays off.
    """)
    return


@app.cell
def _(date, mo, timedelta):
    asof_date = mo.ui.date(
        value=date(2026, 9, 17),
        start=date(2026, 8, 16),
        stop=date.today() - timedelta(days=1),
        label="As-of date (bets placed this day)",
    )
    asof_hour = mo.ui.slider(0, 23, value=18, label="As-of hour (UTC)")
    target_multiple = mo.ui.slider(10, 60, value=30, label="Target payout multiple (x)")
    band_tol = mo.ui.slider(
        1.05, 2.0, value=1.25, step=0.05, label="Multiple band tolerance (x)"
    )
    leg_ks = mo.ui.multiselect(
        options=["2", "3", "4"], value=["2", "3"], label="Leg counts"
    )
    semantic_3leg = mo.ui.checkbox(
        value=True,
        label="Correlated 3-leg template: team ML + same-team player prop + total over",
    )
    semantic_4leg = mo.ui.checkbox(
        value=True,
        label="Correlated 4-leg template: adds that team's total over (KXNFLTEAMTOTAL)",
    )
    semantic_max_leg_ask = mo.ui.slider(
        0.05, 0.90, value=0.60, step=0.01,
        label="Max leg YES ask for the semantic templates (totals/MLs quote ~0.5; the band filter still enforces the payout profile)",
    )
    max_leg_ask = mo.ui.slider(
        0.05, 0.60, value=0.35, step=0.01, label="Max leg YES ask"
    )
    game_slice = mo.ui.radio(
        options={
            "Same-game + cross-game control": "both",
            "Same game only (correlated)": "same_game",
            "Cross game only (independence control)": "cross_game",
        },
        value="Same-game + cross-game control",
        label="Game slice",
    )
    max_legs_per_game = mo.ui.slider(
        6, 40, value=20, label="Max legs per game (ranked by volume)"
    )
    per_slice_cap = mo.ui.slider(
        50, 2000, value=400, step=50, label="Cap parlays per slice per k"
    )
    mo.vstack(
        [
            mo.md("## Knobs"),
            asof_date,
            asof_hour,
            target_multiple,
            band_tol,
            leg_ks,
            semantic_3leg,
            semantic_4leg,
            semantic_max_leg_ask,
            max_leg_ask,
            game_slice,
            max_legs_per_game,
            per_slice_cap,
        ]
    )
    return (
        asof_date,
        asof_hour,
        band_tol,
        game_slice,
        leg_ks,
        max_leg_ask,
        max_legs_per_game,
        per_slice_cap,
        semantic_3leg,
        semantic_4leg,
        semantic_max_leg_ask,
        target_multiple,
    )


@app.cell
def _(attach_lake, connect, mo, self_check):
    port_errors = self_check()
    try:
        conn = connect()
    except Exception:
        # Both .cache sidecars are locked by other notebook kernels; a
        # read-only backtest needs no persistent DuckDB memo.
        import duckdb

        conn = duckdb.connect()
    lake_status = attach_lake(conn)
    _ok = lake_status.get("ok")
    _detail = lake_status.get("alias") if _ok else lake_status.get("error")
    mo.md(
        f"""
        ## Boot

        Strategy port check: **{"ok" if not port_errors else "; ".join(port_errors)}**

        Iceberg attach: **{"attached" if _ok else "failed"}** — `{_detail}`
        """
    )
    return conn, lake_status


@app.cell
def _(conn, lake_status, load_lake_tape, mo):
    if lake_status.get("ok"):
        lake_markets, lake_notes = load_lake_tape(conn)
    else:
        lake_markets, lake_notes = [], ["Lake attach failed."]
    mo.md("### Lake load\n\n" + "\n\n".join(f"- {n}" for n in lake_notes))
    return (lake_markets,)


@app.cell
def _(
    asof_date,
    asof_hour,
    datetime,
    lake_markets,
    leg_universe,
    max_leg_ask,
    max_legs_per_game,
    mo,
    pl,
    time,
    timezone,
):
    at_dt = datetime.combine(
        asof_date.value, time(asof_hour.value), tzinfo=timezone.utc
    )
    at_ms = at_dt.timestamp() * 1000
    leg_pool, universe_notes = leg_universe(
        lake_markets,
        at_ms,
        max_leg_ask=max_leg_ask.value,
        max_legs_per_game=max_legs_per_game.value,
    )
    _games: dict[str, list] = {}
    for _leg in leg_pool:
        _games.setdefault(_leg.game_key, []).append(_leg)
    _game_rows = [
        {
            "game": game,
            "legs": len(pool),
            "min_ask": round(min(l.ask for l in pool), 3),
            "max_ask": round(max(l.ask for l in pool), 3),
            "top_volume_ticker": max(pool, key=lambda l: l.volume).market_ticker,
        }
        for game, pool in sorted(_games.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    ]
    universe_table = pl.DataFrame(_game_rows) if _game_rows else pl.DataFrame()
    mo.vstack(
        [
            mo.md(
                f"""
                ## As-of universe

                As-of **{at_dt.isoformat()}**. {" ".join(universe_notes)}
                """
            ),
            mo.ui.table(universe_table, selection=None)
            if universe_table.height
            else mo.md("_No open tradable legs at as-of — try another date/hour._"),
        ]
    )
    return at_ms, leg_pool


@app.cell
def _(
    at_ms,
    band_tol,
    build_correlated_3leg_parlays,
    build_correlated_4leg_parlays,
    build_cross_game_parlays,
    build_same_game_parlays,
    game_slice,
    lake_markets,
    leg_ks,
    leg_pool,
    mo,
    per_slice_cap,
    semantic_3leg,
    semantic_4leg,
    semantic_max_leg_ask,
    target_multiple,
):
    _ks = sorted(int(k) for k in (leg_ks.value or []))
    parlays = []
    construct_notes = []
    for _k in _ks:
        if game_slice.value in ("both", "same_game"):
            _same = build_same_game_parlays(
                leg_pool,
                _k,
                target_multiple=target_multiple.value,
                band_tol=band_tol.value,
                per_game_cap=per_slice_cap.value,
            )
            parlays.extend(_same)
            construct_notes.append(f"same_game k={_k}: {len(_same)} parlays")
        if game_slice.value in ("both", "cross_game"):
            _cross = build_cross_game_parlays(
                leg_pool,
                _k,
                target_multiple=target_multiple.value,
                band_tol=band_tol.value,
                cap=per_slice_cap.value,
            )
            parlays.extend(_cross)
            construct_notes.append(f"cross_game k={_k}: {len(_cross)} parlays")
    # Semantic selection, not enumeration: the template slots are drawn straight
    # from the tape (the volume-capped leg pool drops low-volume prop/total
    # tickers the templates need). The templates have their own leg-ask cap —
    # moneylines and totals quote around 0.5 and the payout band filter does the
    # real selection.
    _sem_kwargs = dict(
        target_multiple=target_multiple.value,
        band_tol=band_tol.value,
        per_game_cap=per_slice_cap.value,
        max_leg_ask=semantic_max_leg_ask.value,
    )
    if semantic_3leg.value:
        _s3, _s3_notes = build_correlated_3leg_parlays(
            lake_markets, at_ms, **_sem_kwargs
        )
        parlays.extend(_s3)
        construct_notes.append(f"same_game_semantic k=3: {len(_s3)} parlays")
        construct_notes.extend(_s3_notes)
    if semantic_4leg.value:
        _s4, _s4_notes = build_correlated_4leg_parlays(
            lake_markets, at_ms, **_sem_kwargs
        )
        parlays.extend(_s4)
        construct_notes.append(f"same_game_semantic k=4: {len(_s4)} parlays")
        construct_notes.extend(_s4_notes)
    mo.md(
        "### Constructed parlays\n\n"
        + "\n".join(f"- {n}" for n in construct_notes)
        + (
            "\n\nPick at least one leg count."
            if not _ks
            else ""
        )
    )
    return (parlays,)


@app.cell
def _(mo):
    hydrate_legs = mo.ui.run_button(
        label="Hydrate missing leg settlements (signed GET, chunks of 100)"
    )
    hydrate_legs
    return (hydrate_legs,)


@app.cell
def _(
    conn,
    get_json,
    hydrate_legs,
    hydrate_ticker_settlements,
    load_n_leg_settlements,
    mo,
    parlays,
    record_n_leg_settlements,
):
    grades = load_n_leg_settlements(conn)
    grade_note = f"Loaded {len(grades)} cached grades from the session memo."
    if hydrate_legs.value and parlays:
        _needed = sorted({leg.market_ticker for p in parlays for leg in p.legs})
        grades, _fetched = hydrate_ticker_settlements(
            _needed, get_json, hydrated=grades
        )
        record_n_leg_settlements(conn, grades)
        grade_note = (
            f"Hydrated {_fetched} finalized leg results by signed GET "
            f"({len(_needed)} leg tickers needed; cached in the session "
            "DuckDB, not Iceberg)."
        )
    mo.md(f"### Leg grades\n\n{grade_note}")
    return (grades,)


@app.cell
def _(grade_parlays, grades, lake_markets, mo, parlays, pl, summarize_parlays):
    graded_parlays = grade_parlays(parlays, lake_markets, grades)
    summary_rows = summarize_parlays(graded_parlays)
    summary_table = pl.DataFrame(summary_rows) if summary_rows else pl.DataFrame()

    def _pick(rows, game_slice_value):
        return [r for r in rows if r["game_slice"] == game_slice_value]

    _same_rows = _pick(summary_rows, "same_game")
    _cross_rows = _pick(summary_rows, "cross_game")
    _semantic_rows = _pick(summary_rows, "same_game_semantic")
    def _mean_edge(rows):
        _vals = [r["realized_minus_indep_pp"] for r in rows if r["graded"]]
        return round(sum(_vals) / len(_vals), 2) if _vals else None

    _same_edge = _mean_edge(_same_rows)
    _cross_edge = _mean_edge(_cross_rows)
    _semantic_edge = _mean_edge(_semantic_rows)
    _verdict = (
        "No graded parlays yet — click the hydrate button if grades are missing."
    )
    if (
        _same_edge is not None
        or _cross_edge is not None
        or _semantic_edge is not None
    ):
        _verdict = (
            "Correlation verdict (mean realized − indep): same-game = "
            f"**{_same_edge if _same_edge is not None else 'n/a'} pp**, "
            f"cross-game = **{_cross_edge if _cross_edge is not None else 'n/a'} pp**, "
            "semantic 3-leg = "
            f"**{_semantic_edge if _semantic_edge is not None else 'n/a'} pp**. "
            "Positive same-game edge above the cross-game control is the signal "
            "that correlation beats the ask spread."
        )
    mo.vstack(
        [
            mo.md(f"## Results\n\n{_verdict}"),
            mo.ui.table(summary_table, selection=None)
            if summary_table.height
            else mo.md("_No parlays constructed — widen the band or change date._"),
        ]
    )
    return (graded_parlays,)


@app.cell
def _(graded_parlays, mo, pl):
    _detail = sorted(
        graded_parlays,
        key=lambda p: -sum(leg.volume for leg in p.legs),
    )[:30]
    _rows = [
        {
            "game_slice": p.game_group,
            "legs": len(p.legs),
            "leg_tickers": "; ".join(f"{leg.market_ticker}@{leg.ask:.3f}" for leg in p.legs),
            "games": "; ".join(sorted({leg.game_key for leg in p.legs})),
            "multiple": p.multiple,
            "p_indep": p.p_indep,
            "settlement": p.settlement,
            "graded": p.graded,
            "grade_sources": ",".join(p.settlement_sources),
        }
        for p in _detail
    ]
    detail_table = pl.DataFrame(_rows) if _rows else pl.DataFrame()
    mo.vstack(
        [
            mo.md("### Top parlays by leg volume"),
            mo.ui.table(detail_table, selection=None)
            if detail_table.height
            else mo.md("_No parlays._"),
        ]
    )
    return


@app.cell
def _(at_ms, lake_markets, mo, pl, rolled_vs_listed):
    combo_rows, combo_notes = rolled_vs_listed(lake_markets, at_ms)
    combo_table = pl.DataFrame(combo_rows) if combo_rows else pl.DataFrame()
    _cheaper = sum(1 for r in combo_rows if r["rolled_minus_combo"] < 0)
    mo.vstack(
        [
            mo.md(
                """
                ### Rolled legs vs the listed two-leg combo (same game)

                The listed combo market is the direct alternative to rolling
                the same two legs yourself. `rolled_minus_combo < 0` means
                rolling the legs was cheaper than buying the combo at its
                as-of ask.
                """
            ),
            mo.ui.table(combo_table, selection=None)
            if combo_table.height
            else mo.md("_No same-game two-leg combos with both legs priced at as-of._"),
            mo.md(
                f"{' '.join(combo_notes)} Rolling cheaper for **{_cheaper}** "
                f"of {len(combo_rows)}."
            ),
        ]
    )
    return


@app.cell
def _(mo, parlays):
    mo.md(f"""
    ## Summary

    Iceberg tape only; {len(parlays)} constructed parlays. Lake rows are
    read-only here — grades hydrate into the local session memo, never
    `lake.*`. No live CLOB, no RFQ create/accept, LIVE off.
    """)
    return


if __name__ == "__main__":
    app.run()
