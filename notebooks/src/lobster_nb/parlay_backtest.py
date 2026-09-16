"""Lake RFQ backtest + live CLOB screen. Port of worker/src/kalshi-parlay-backtest.ts."""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from math import isfinite
from typing import Any, Iterable, Literal

from lobster_nb.mve import (
    ParsedMveCategory,
    mve_tape_kind,
    parse_mve_category,
    parlay_game_group,
    sports_game_key,
)
from lobster_nb.parlay import (
    BOOKS,
    BOOK_CORR_ROOM,
    BOOK_LONGSHOT,
    BOOK_UNDERDOG,
    KALSHI_RFQ_SOURCE,
    PARLAY_MAX_CONTRACTS,
    PRODUCTION_KNOBS,
    PERTURBATIONS,
    ParlayKnobs,
    ParlayQuoteDecision,
    ParlayQuoteInput,
    evaluate_parlay_executor_quote,
    fill_pnl,
    has_tradable_quote,
    infer_combo_settlement,
    is_kalshi_parlay_fill_source,
    is_kalshi_settlement_source,
    is_two_sided,
    kalshi_taker_fee,
    live_fill_pnl,
    parse_fill_side,
    parse_kalshi_number,
    quote_mid,
    round4,
    settlement_yes,
)

GameSlice = Literal["all", "same_game", "cross_game"]


def _num(raw: Any) -> float | None:
    return parse_kalshi_number(raw)


def _str(raw: Any) -> str:
    return raw.strip() if isinstance(raw, str) else (str(raw).strip() if raw is not None else "")


def _iso(raw: Any) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw.isoformat()
    text = str(raw).strip()
    return text or None


def coerce_market(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "market_ticker": _str(row.get("market_ticker")).upper(),
        "event_ticker": _str(row.get("event_ticker")).upper() or None,
        "title": _str(row.get("title")) or _str(row.get("market_ticker")),
        "category": _str(row.get("category")) or None,
        "status": _str(row.get("status")) or "unknown",
        "market_type": _str(row.get("market_type")) or None,
        "yes_bid": _num(row.get("yes_bid")),
        "yes_ask": _num(row.get("yes_ask")),
        "yes_last": _num(row.get("yes_last")),
        "no_bid": _num(row.get("no_bid")),
        "volume": _num(row.get("volume")),
        "liquidity": _num(row.get("liquidity")),
        "yes_subtitle": _str(row.get("yes_subtitle")) or None,
        "close_time": _iso(row.get("close_time")),
        "fetched_at": _iso(row.get("fetched_at")),
        "source": _str(row.get("source")).lower() or None,
        "result": row.get("result"),
        "theme": _str(row.get("theme")),
    }


def fetched_ms(row: dict[str, Any]) -> float:
    raw = row.get("fetched_at")
    if not raw:
        return 0.0
    if isinstance(raw, datetime):
        return raw.timestamp() * 1000
    text = str(raw).strip()
    if not text:
        return 0.0
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text).timestamp() * 1000
    except ValueError:
        return 0.0


def group_by_ticker(markets: Iterable[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for raw in markets:
        row = coerce_market(raw) if "yes_bid" in raw or "market_ticker" in raw else raw
        ticker = _str(row.get("market_ticker")).upper()
        if not ticker:
            continue
        grouped[ticker].append(row if row.get("market_ticker") == ticker else coerce_market(row))
    for snaps in grouped.values():
        snaps.sort(key=fetched_ms, reverse=True)
    return grouped


def is_rfq_two_way(row: dict[str, Any]) -> bool:
    if str(row.get("source") or "").lower() != KALSHI_RFQ_SOURCE:
        return False
    if is_kalshi_settlement_source(row.get("source")):
        return False
    bid = row.get("yes_bid")
    ask = row.get("yes_ask")
    return (
        bid is not None
        and ask is not None
        and isfinite(bid)
        and isfinite(ask)
        and bid >= 0
        and ask < 1
        and ask > 0
        and ask >= bid
    )


def ticker_settlement(snaps: list[dict[str, Any]]) -> Literal[0, 1] | None:
    for row in snaps:
        yes = settlement_yes(row)
        if yes in (0, 1):
            return yes
    return None


def nearest_tradable(snaps: list[dict[str, Any]], at_ms: float) -> dict[str, Any] | None:
    best = None
    best_abs = float("inf")
    for row in snaps:
        if is_kalshi_settlement_source(row.get("source")):
            continue
        if is_kalshi_parlay_fill_source(row.get("source")):
            continue
        if not has_tradable_quote(row.get("yes_bid"), row.get("yes_ask"), row.get("yes_last")):
            continue
        delta = abs(fetched_ms(row) - at_ms)
        if delta < best_abs:
            best_abs = delta
            best = row
    return best


def combo_category(snaps: list[dict[str, Any]]) -> ParsedMveCategory | None:
    for row in snaps:
        parsed = parse_mve_category(row.get("category"))
        if parsed:
            return parsed
    return None


@dataclass
class ScoredRfq:
    market_ticker: str
    title: str
    quoted_at: str | None
    p: float
    q: float
    yes_bid: float
    yes_ask: float
    independence: float
    corr_room: float
    phi: float | None
    payout_multiple: float
    game_group: str
    sides: tuple[str, ...]
    settlement: Literal[0, 1] | None
    yes_pnl: float | None
    no_pnl: float | None
    books: dict[str, ParlayQuoteDecision]


@dataclass
class Cohort:
    n: int = 0
    would_accept: int = 0
    settled: int = 0
    yes_wins: int = 0
    hit_rate: float | None = None
    ev_yes: float = 0.0
    ev_actual: float = 0.0
    avg_ask: float | None = None
    avg_corr_room: float | None = None

    def as_row(self, book: str, game_slice: str, knobs: ParlayKnobs) -> dict[str, Any]:
        return {
            "book": book,
            "game_slice": game_slice,
            "n": self.n,
            "would_accept": self.would_accept,
            "settled": self.settled,
            "yes_wins": self.yes_wins,
            "hit_rate": self.hit_rate,
            "ev_yes": self.ev_yes,
            "ev_actual": self.ev_actual,
            "avg_ask": self.avg_ask,
            "avg_corr_room": self.avg_corr_room,
            "contracts": knobs.contracts,
        }


@dataclass
class LiveFill:
    market_ticker: str
    title: str
    quoted_at: str | None
    fill_side: str
    contracts: float
    yes_price: float
    no_price: float
    fee: float
    settlement: Literal[0, 1] | None
    actual_pnl: float | None
    yes_counterfactual_pnl: float | None


@dataclass
class LiveFillCohort:
    n: int = 0
    settled: int = 0
    wins: int = 0
    hit_rate: float | None = None
    actual_pnl: float = 0.0
    yes_counterfactual_pnl: float = 0.0
    fills: list[LiveFill] = field(default_factory=list)


@dataclass
class LakeBacktest:
    contracts: int
    rfq_snapshots: int
    rfq_tickers: int
    aligned: int
    crypto_skipped: int
    scored: list[ScoredRfq]
    live: LiveFillCohort
    notes: list[str]


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _hit_rate(wins: int, settled: int) -> float | None:
    if not settled:
        return None
    return wins / settled


def summarize_book(
    scored: list[ScoredRfq],
    book: str,
    game_slice: GameSlice,
    knobs: ParlayKnobs,
) -> Cohort:
    rows = scored
    if game_slice != "all":
        rows = [r for r in rows if r.game_group == game_slice]
    accepted = [r for r in rows if r.books[book].ok]
    asks = [r.yes_ask for r in accepted]
    rooms = [r.corr_room for r in accepted]
    settled = 0
    yes_wins = 0
    ev_yes = 0.0
    ev_actual = 0.0
    for row in accepted:
        if row.settlement not in (0, 1):
            continue
        settled += 1
        if row.settlement == 1:
            yes_wins += 1
        if row.yes_pnl is not None:
            ev_yes += row.yes_pnl
        if row.no_pnl is not None:
            ev_actual += row.no_pnl
    return Cohort(
        n=len(rows),
        would_accept=len(accepted),
        settled=settled,
        yes_wins=yes_wins,
        hit_rate=_hit_rate(yes_wins, settled),
        ev_yes=round4(ev_yes),
        ev_actual=round4(ev_actual),
        avg_ask=_mean(asks),
        avg_corr_room=_mean(rooms),
    )


def score_quote(
    combo: dict[str, Any],
    parsed: ParsedMveCategory,
    by_ticker: dict[str, list[dict[str, Any]]],
    knobs: ParlayKnobs,
) -> ScoredRfq | None:
    at_ms = fetched_ms(combo)
    sides: list[str] = []
    games: list[str] = []
    probs: list[float] = []
    for spec in parsed.legs:
        leg_snaps = by_ticker.get(spec.market_ticker, [])
        leg_row = nearest_tradable(leg_snaps, at_ms)
        if not leg_row:
            return None
        prob = quote_mid(leg_row.get("yes_bid"), leg_row.get("yes_ask"), leg_row.get("yes_last"))
        if prob is not None and spec.side == "no":
            prob = 1 - prob
        if (
            prob is None
            or not has_tradable_quote(leg_row.get("yes_bid"), leg_row.get("yes_ask"), leg_row.get("yes_last"))
        ):
            return None
        sides.append(spec.side)
        probs.append(prob)
        games.append(sports_game_key(spec.market_ticker, spec.event_ticker or leg_row.get("event_ticker")))
    if len(probs) != 2:
        return None
    group = parlay_game_group(games)
    inp = ParlayQuoteInput(
        market_ticker=combo["market_ticker"],
        same_game=group == "same_game",
        cross_game=group == "cross_game",
        sides=tuple(sides),  # type: ignore[arg-type]
        p=probs[0],
        q=probs[1],
        yes_bid=combo.get("yes_bid") or 0.0,
        yes_ask=combo.get("yes_ask") or 0.0,
        quote_id="lake_rfq",
    )
    books = {book: evaluate_parlay_executor_quote(inp, book, knobs) for book in BOOKS}
    any_decision = books[BOOK_CORR_ROOM]
    combo_settle = ticker_settlement(by_ticker.get(combo["market_ticker"], []))
    leg_settle = infer_combo_settlement(
        [
            (spec.side, ticker_settlement(by_ticker.get(spec.market_ticker, [])))
            for spec in parsed.legs
        ]
    )
    settlement = combo_settle if combo_settle is not None else leg_settle
    contracts = min(PARLAY_MAX_CONTRACTS, max(1, int(knobs.contracts)))
    yes_pnl = no_pnl = None
    if settlement in (0, 1):
        yes_pnl, no_pnl = fill_pnl(
            settlement,
            combo.get("yes_bid") or 0.0,
            combo.get("yes_ask") or 0.0,
            contracts,
        )
    return ScoredRfq(
        market_ticker=combo["market_ticker"],
        title=combo.get("title") or combo["market_ticker"],
        quoted_at=combo.get("fetched_at"),
        p=probs[0],
        q=probs[1],
        yes_bid=combo.get("yes_bid") or 0.0,
        yes_ask=combo.get("yes_ask") or 0.0,
        independence=any_decision.independence,
        corr_room=any_decision.corr_room,
        phi=any_decision.phi,
        payout_multiple=any_decision.payout_multiple,
        game_group=group,
        sides=tuple(sides),
        settlement=settlement,
        yes_pnl=yes_pnl,
        no_pnl=no_pnl,
        books=books,
    )


def score_live_fills(
    markets: list[dict[str, Any]],
    by_ticker: dict[str, list[dict[str, Any]]],
) -> LiveFillCohort:
    tickets: list[LiveFill] = []
    for raw in markets:
        row = coerce_market(raw)
        if not is_kalshi_parlay_fill_source(row.get("source")):
            continue
        fill_side = parse_fill_side(row.get("yes_subtitle"))
        yes_price = row.get("yes_bid")
        no_price = row.get("no_bid")
        if no_price is None and yes_price is not None:
            no_price = 1 - yes_price
        contracts = row["volume"] if row.get("volume") and row["volume"] > 0 else PARLAY_MAX_CONTRACTS
        if not fill_side or yes_price is None or no_price is None:
            continue
        fee = (
            row["liquidity"]
            if row.get("liquidity") is not None and isfinite(row["liquidity"])
            else contracts * kalshi_taker_fee(no_price if fill_side == "no" else yes_price)
        )
        settlement = ticker_settlement(by_ticker.get(row["market_ticker"], []))
        actual = yes_cf = None
        if settlement in (0, 1):
            actual, yes_cf = live_fill_pnl(
                fill_side, settlement, yes_price, no_price, contracts, fee
            )
        tickets.append(
            LiveFill(
                market_ticker=row["market_ticker"],
                title=row["title"],
                quoted_at=row.get("fetched_at"),
                fill_side=fill_side,
                contracts=contracts,
                yes_price=yes_price,
                no_price=no_price,
                fee=fee,
                settlement=settlement,
                actual_pnl=actual,
                yes_counterfactual_pnl=yes_cf,
            )
        )
    tickets.sort(key=lambda t: t.quoted_at or "", reverse=True)
    settled = wins = 0
    actual_pnl = yes_cf_pnl = 0.0
    for ticket in tickets:
        if ticket.settlement not in (0, 1):
            continue
        settled += 1
        won = ticket.settlement == 1 if ticket.fill_side == "yes" else ticket.settlement == 0
        if won:
            wins += 1
        if ticket.actual_pnl is not None:
            actual_pnl += ticket.actual_pnl
        if ticket.yes_counterfactual_pnl is not None:
            yes_cf_pnl += ticket.yes_counterfactual_pnl
    return LiveFillCohort(
        n=len(tickets),
        settled=settled,
        wins=wins,
        hit_rate=_hit_rate(wins, settled),
        actual_pnl=round4(actual_pnl),
        yes_counterfactual_pnl=round4(yes_cf_pnl),
        fills=tickets[:24],
    )


def backtest_parlay_books(
    markets: list[dict[str, Any]],
    knobs: ParlayKnobs = PRODUCTION_KNOBS,
) -> LakeBacktest:
    contracts = min(PARLAY_MAX_CONTRACTS, max(1, int(knobs.contracts)))
    coerced = [coerce_market(row) for row in markets]
    if not coerced:
        return LakeBacktest(
            contracts,
            0,
            0,
            0,
            0,
            [],
            LiveFillCohort(),
            ["No sports lake rows to backtest."],
        )
    by_ticker = group_by_ticker(coerced)
    first_rfq: list[ScoredRfq] = []
    rfq_snapshots = 0
    rfq_tickers = 0
    crypto_skipped = 0
    for snaps in by_ticker.values():
        parsed = combo_category(snaps)
        if not parsed or len(parsed.legs) != 2:
            continue
        tape = mve_tape_kind([leg.market_ticker for leg in parsed.legs])
        if tape != "sports":
            if tape == "crypto_mve" and any(is_rfq_two_way(s) for s in snaps):
                crypto_skipped += 1
            continue
        rfqs = [row for row in snaps if is_rfq_two_way(row)]
        rfqs.sort(key=fetched_ms)
        if not rfqs:
            continue
        rfq_tickers += 1
        rfq_snapshots += len(rfqs)
        scored = None
        for rfq in rfqs:
            scored = score_quote(rfq, parsed, by_ticker, knobs)
            if scored:
                break
        if scored:
            first_rfq.append(scored)

    notes: list[str] = []
    if not rfq_tickers:
        notes.append(
            "No solicited RFQ two-ways (source=kalshi_rfq) on sports two-leg combos this window."
        )
    elif rfq_tickers < 30:
        notes.append(
            f"Lake RFQ history is thin: {rfq_tickers} sports two-leg tickers "
            f"({rfq_snapshots} snapshots). Treat EV as a sketch, not a production edge."
        )
    notes.append(
        "Strategy EV is BUY YES at the RFQ ask minus Kalshi taker fees, "
        f"{contracts} contracts. ev_actual is BUY NO at 1 − yes_bid "
        "(production 2026-09-14 fill side)."
    )
    if crypto_skipped:
        notes.append(
            f"Skipped {crypto_skipped} crypto-only 15m/daily CROSSCATEGORY stacks from the sports books."
        )
    live = score_live_fills(coerced, by_ticker)
    if not live.n:
        notes.append("No source=kalshi_parlay_fill rows yet.")
    else:
        notes.append(
            f"Live fills: {live.n} tickets, {live.settled} settled, "
            f"actual P&L {live.actual_pnl} vs YES-at-ask {live.yes_counterfactual_pnl}."
        )
    return LakeBacktest(
        contracts=contracts,
        rfq_snapshots=rfq_snapshots,
        rfq_tickers=rfq_tickers,
        aligned=len(first_rfq),
        crypto_skipped=crypto_skipped,
        scored=first_rfq,
        live=live,
        notes=notes,
    )


def lake_score_table(bt: LakeBacktest, knobs: ParlayKnobs) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for book in BOOKS:
        for slice_name in ("all", "same_game", "cross_game"):
            cohort = summarize_book(bt.scored, book, slice_name, knobs)  # type: ignore[arg-type]
            rows.append(cohort.as_row(book, slice_name, knobs))
    return rows


def perturbation_table(markets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Production knobs vs one perturbation at a time."""
    base = backtest_parlay_books(markets, PRODUCTION_KNOBS)
    out: list[dict[str, Any]] = []
    for book in BOOKS:
        prod = summarize_book(base.scored, book, "all", PRODUCTION_KNOBS)
        out.append(
            {
                "label": "production",
                "book": book,
                "n": prod.n,
                "would_accept": prod.would_accept,
                "settled": prod.settled,
                "hit_rate": prod.hit_rate,
                "ev_yes": prod.ev_yes,
                "ev_actual": prod.ev_actual,
                "delta_accept": 0,
                "delta_ev_yes": 0.0,
            }
        )
    for label, knobs in PERTURBATIONS:
        alt = backtest_parlay_books(markets, knobs)
        for book in BOOKS:
            prod = summarize_book(base.scored, book, "all", PRODUCTION_KNOBS)
            other = summarize_book(alt.scored, book, "all", knobs)
            out.append(
                {
                    "label": label,
                    "book": book,
                    "n": other.n,
                    "would_accept": other.would_accept,
                    "settled": other.settled,
                    "hit_rate": other.hit_rate,
                    "ev_yes": other.ev_yes,
                    "ev_actual": other.ev_actual,
                    "delta_accept": other.would_accept - prod.would_accept,
                    "delta_ev_yes": round4(other.ev_yes - prod.ev_yes),
                }
            )
    return out


def persist_ok(
    ticker: str,
    book: str,
    knobs: ParlayKnobs,
    candles_by_ticker: dict[str, list[dict[str, Any]]],
    template: ParlayQuoteInput,
) -> tuple[bool, str | None]:
    n = int(knobs.persist_n_minutes)
    if n <= 0:
        return True, None
    candles = candles_by_ticker.get(ticker.upper(), [])
    if not candles:
        return True, "no_1m_cache"
    recent = candles[-n:]
    if len(recent) < n:
        return False, "persist_short"
    for candle in recent:
        bid = candle.get("yes_bid")
        ask = candle.get("yes_ask")
        if bid is None or ask is None:
            return False, "persist_gap"
        inp = ParlayQuoteInput(
            market_ticker=template.market_ticker,
            same_game=template.same_game,
            cross_game=template.cross_game,
            sides=template.sides,
            p=template.p,
            q=template.q,
            yes_bid=float(bid),
            yes_ask=float(ask),
            quote_id=template.quote_id,
        )
        if not evaluate_parlay_executor_quote(inp, book, knobs).ok:
            return False, "persist_break"
    return True, None


def score_live_combos(
    combos: list[dict[str, Any]],
    legs_by_ticker: dict[str, dict[str, Any]],
    knobs: ParlayKnobs = PRODUCTION_KNOBS,
    candles_by_ticker: dict[str, list[dict[str, Any]]] | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Score open two-leg sports CLOB two-ways. Never accepts. quote_id=live_clob."""
    candles_by_ticker = candles_by_ticker or {}
    rows: list[dict[str, Any]] = []
    notes: list[str] = []
    crypto = 0
    no_legs = 0
    empty_book = 0
    for combo in combos:
        row = coerce_market(combo)
        parsed = parse_mve_category(row.get("category"))
        if not parsed or len(parsed.legs) != 2:
            continue
        tape = mve_tape_kind([leg.market_ticker for leg in parsed.legs])
        if tape != "sports":
            if tape == "crypto_mve":
                crypto += 1
            continue
        sides = []
        games = []
        probs = []
        missing = False
        for spec in parsed.legs:
            leg = legs_by_ticker.get(spec.market_ticker)
            if not leg:
                missing = True
                break
            prob = quote_mid(leg.get("yes_bid"), leg.get("yes_ask"), leg.get("yes_last"))
            if prob is not None and spec.side == "no":
                prob = 1 - prob
            if prob is None or not has_tradable_quote(
                leg.get("yes_bid"), leg.get("yes_ask"), leg.get("yes_last")
            ):
                missing = True
                break
            sides.append(spec.side)
            probs.append(prob)
            games.append(sports_game_key(spec.market_ticker, spec.event_ticker or leg.get("event_ticker")))
        if missing or len(probs) != 2:
            no_legs += 1
            continue
        two_way = is_two_sided(row.get("yes_bid"), row.get("yes_ask"))
        if not two_way:
            empty_book += 1
        group = parlay_game_group(games)
        inp = ParlayQuoteInput(
            market_ticker=row["market_ticker"],
            same_game=group == "same_game",
            cross_game=group == "cross_game",
            sides=tuple(sides),  # type: ignore[arg-type]
            p=probs[0],
            q=probs[1],
            yes_bid=float(row.get("yes_bid") or 0.0),
            yes_ask=float(row.get("yes_ask") or 0.0),
            quote_id="live_clob" if two_way else None,
        )
        persist_note = None
        for book in BOOKS:
            decision = evaluate_parlay_executor_quote(inp, book, knobs)
            ok, persist_reason = persist_ok(
                row["market_ticker"], book, knobs, candles_by_ticker, inp
            )
            reasons = list(decision.reasons)
            action = decision.action
            if persist_reason == "no_1m_cache":
                persist_note = persist_reason
            elif not ok:
                reasons.append(persist_reason or "persist")
                action = "skip"
            rows.append(
                {
                    "book": book,
                    "market_ticker": row["market_ticker"],
                    "title": row["title"],
                    "game": group,
                    "sides": "/".join(sides),
                    "p": round4(probs[0]),
                    "q": round4(probs[1]),
                    "yes_bid": row.get("yes_bid"),
                    "yes_ask": row.get("yes_ask"),
                    "independence": round4(decision.independence),
                    "corr_room": round4(decision.corr_room),
                    "phi": None if decision.phi is None else round4(decision.phi),
                    "payout": round4(decision.payout_multiple),
                    "reasons": ",".join(reasons) if reasons else "",
                    "action": action,
                    "two_sided": two_way,
                }
            )
        if persist_note:
            notes.append("persist-N unused: no 1m candle cache for some tickers.")
    if crypto:
        notes.append(f"Live tape skipped {crypto} crypto-only MVE stacks.")
    if empty_book:
        notes.append(
            f"{empty_book} two-leg sports combos have no two-sided CLOB (typical RFQ-only books)."
        )
    if no_legs:
        notes.append(f"{no_legs} combos missing aligned tradable legs.")
    notes.append("Live CLOB screen only — quote_id=live_clob, no RFQ create/accept.")
    # de-dupe persist notes
    notes = list(dict.fromkeys(notes))
    return rows, notes


LAKE_TAPE_SQL = """
SELECT
  market_ticker, event_ticker, title, category, status, theme, market_type,
  yes_bid, yes_ask, yes_last, no_bid, volume, liquidity, yes_subtitle,
  close_time, fetched_at, source
FROM lake.options.kalshi_markets
WHERE source IN ('kalshi_rfq', 'kalshi_settlement', 'kalshi_parlay_fill')
LIMIT 8000
"""

LAKE_SPORTS_SQL = """
SELECT
  market_ticker, event_ticker, title, category, status, theme, market_type,
  yes_bid, yes_ask, yes_last, no_bid, volume, liquidity, yes_subtitle,
  close_time, fetched_at, source
FROM lake.options.kalshi_markets
WHERE theme = 'sports' OR CAST(category AS VARCHAR) LIKE 'mve|%'
ORDER BY fetched_at DESC
LIMIT 8000
"""

PROBE_SQL = """
SELECT market_ticker, source, theme, status, yes_bid, yes_ask, fetched_at
FROM lake.options.kalshi_markets
WHERE theme = 'sports'
LIMIT 20
"""


def query_dicts(conn: Any, sql: str) -> list[dict[str, Any]]:
    rel = conn.execute(sql)
    cols = [d[0] for d in rel.description]
    return [dict(zip(cols, row)) for row in rel.fetchall()]


def missing_settlement_tickers(markets: list[dict[str, Any]]) -> list[str]:
    by_ticker = group_by_ticker(markets)
    out: list[str] = []
    for ticker, snaps in by_ticker.items():
        if combo_category(snaps) is None:
            continue
        if not any(is_rfq_two_way(s) for s in snaps) and not any(
            is_kalshi_parlay_fill_source(s.get("source")) for s in snaps
        ):
            continue
        if ticker_settlement(snaps) is not None:
            continue
        out.append(ticker)
    return out


def hydrate_settlements(
    markets: list[dict[str, Any]],
    get_json_fn: Any,
    max_tickers: int = 40,
) -> tuple[list[dict[str, Any]], int]:
    """Fill missing combo 0/1 from GET /markets?tickers=… Lake rows still win."""
    from urllib.parse import quote

    missing = missing_settlement_tickers(markets)[: max(0, min(80, max_tickers))]
    if not missing:
        return [], 0
    extra: list[dict[str, Any]] = []
    by_ticker = group_by_ticker(markets)
    for i in range(0, len(missing), 20):
        chunk = missing[i : i + 20]
        result = get_json_fn(f"/markets?tickers={quote(','.join(chunk))}&limit=200")
        nested = (result.get("json") or {}).get("markets") if isinstance(result, dict) else None
        if not isinstance(nested, list):
            continue
        for raw in nested:
            if not isinstance(raw, dict):
                continue
            ticker = str(raw.get("ticker") or "").strip().upper()
            if not ticker:
                continue
            prior = (by_ticker.get(ticker) or [None])[0]
            status = str(raw.get("status") or "unknown")
            last = parse_kalshi_number(raw.get("last_price_dollars") or raw.get("last_price"))
            yes = settlement_yes(
                {
                    "status": status,
                    "yes_bid": parse_kalshi_number(raw.get("yes_bid_dollars") or raw.get("yes_bid")),
                    "yes_ask": parse_kalshi_number(raw.get("yes_ask_dollars") or raw.get("yes_ask")),
                    "yes_last": last,
                    "result": raw.get("result"),
                    "source": "kalshi_settlement" if status.lower() in ("settled", "finalized") else None,
                }
            )
            if yes not in (0, 1):
                continue
            extra.append(
                {
                    "market_ticker": ticker,
                    "event_ticker": (prior or {}).get("event_ticker")
                    or str(raw.get("event_ticker") or "").strip().upper()
                    or None,
                    "title": str(raw.get("title") or "").strip() or (prior or {}).get("title") or ticker,
                    "category": (prior or {}).get("category"),
                    "status": "settled",
                    "market_type": (prior or {}).get("market_type"),
                    "yes_bid": yes,
                    "yes_ask": yes,
                    "yes_last": yes,
                    "no_bid": 1 - yes,
                    "volume": None,
                    "liquidity": None,
                    "yes_subtitle": None,
                    "close_time": str(raw.get("close_time") or "").strip() or None,
                    "fetched_at": str(raw.get("close_time") or raw.get("expiration_time") or "").strip()
                    or datetime.now(timezone.utc).isoformat(),
                    "source": "kalshi_settlement",
                    "result": raw.get("result"),
                    "theme": "sports",
                }
            )
    return extra, len(extra)


def load_lake_sports_tape(conn: Any) -> tuple[list[dict[str, Any]], list[str]]:
    notes: list[str] = []
    tape: list[dict[str, Any]] = []
    latest: list[dict[str, Any]] = []
    try:
        tape = query_dicts(conn, LAKE_TAPE_SQL)
    except Exception as exc:
        notes.append(f"tape query failed: {str(exc)[:200]}")
    try:
        latest = query_dicts(conn, LAKE_SPORTS_SQL)
    except Exception as exc:
        notes.append(f"sports query failed: {str(exc)[:200]}")
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for raw in [*tape, *latest]:
        row = coerce_market(raw)
        if not row["market_ticker"]:
            continue
        key = f"{row['market_ticker']}|{row.get('source') or ''}|{row.get('fetched_at') or ''}"
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
    notes.append(f"Loaded {len(out)} lake rows ({len(tape)} tape, {len(latest)} sports/latest).")
    return out, notes


def ensure_strategy_runs(conn: Any) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS strategy_runs (
            run_id VARCHAR,
            recorded_at TIMESTAMP,
            tape VARCHAR,
            book VARCHAR,
            game_slice VARCHAR,
            params_json VARCHAR,
            n INTEGER,
            would_accept INTEGER,
            settled INTEGER,
            hit_rate DOUBLE,
            ev_yes DOUBLE,
            ev_actual DOUBLE,
            notes VARCHAR
        )
        """
    )


def record_strategy_runs(
    conn: Any,
    run_id: str,
    tape: str,
    knobs: ParlayKnobs,
    rows: list[dict[str, Any]],
    notes: str,
) -> None:
    ensure_strategy_runs(conn)
    now = datetime.now(timezone.utc)
    params = json.dumps(knobs.params_json(), sort_keys=True)
    for row in rows:
        conn.execute(
            """
            INSERT INTO strategy_runs
            (run_id, recorded_at, tape, book, game_slice, params_json,
             n, would_accept, settled, hit_rate, ev_yes, ev_actual, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                run_id,
                now,
                tape,
                row.get("book"),
                row.get("game_slice") or "all",
                params,
                int(row.get("n") or 0),
                int(row.get("would_accept") or 0),
                int(row.get("settled") or 0),
                row.get("hit_rate"),
                row.get("ev_yes"),
                row.get("ev_actual"),
                notes[:500],
            ],
        )


def live_book_summary(live_rows: list[dict[str, Any]], knobs: ParlayKnobs) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for book in BOOKS:
        book_rows = [r for r in live_rows if r["book"] == book]
        for slice_name in ("all", "same_game", "cross_game"):
            subset = book_rows if slice_name == "all" else [r for r in book_rows if r["game"] == slice_name]
            accepts = [r for r in subset if r["action"] == "buy_yes"]
            two_sided = [r for r in subset if r.get("two_sided")]
            out.append(
                {
                    "book": book,
                    "game_slice": slice_name,
                    "n": len(subset),
                    "two_sided": len(two_sided),
                    "would_accept": len(accepts),
                    "settled": 0,
                    "yes_wins": 0,
                    "hit_rate": None,
                    "ev_yes": None,
                    "ev_actual": None,
                    "avg_ask": _mean([float(r["yes_ask"]) for r in accepts]),
                    "avg_corr_room": _mean([float(r["corr_room"]) for r in accepts]),
                    "contracts": knobs.contracts,
                }
            )
    return out
