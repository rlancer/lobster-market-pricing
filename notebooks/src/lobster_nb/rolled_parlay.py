"""Rolled correlated-leg parlay construction + as-of-date backtest (lake only).

Strategy under test: "layer a few correlated legs for a ~30:1 payout profile."
A rolled parlay buys leg i at its YES ask (plus Kalshi taker fee) and rolls all
proceeds into the next leg, so $1 risked pays ``1 / prod(ask_i + fee_i)`` iff
every leg hits. Same-game legs are correlated — P(all hit) can exceed the
independence product prod(p_i) — so the question is whether that Fréchet room
beats the ask spread paid at each roll. Cross-game legs (independent across
games) constructed into the same payout band are the control.

All quotes come from the lake's hourly ``source=kalshi`` snapshots as of a
picked past timestamp: the last tradable quote at or before the as-of time of
a market that was still open then (no post-close quotes, no settlements before
the as-of time — no leakage). Grades use later ``source=kalshi_settlement``
rows, with a signed-GET hydration memo for legs the loader never enqueued.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass, field
from itertools import combinations
from math import isfinite
from datetime import datetime, timezone
from typing import Any, Literal

from lobster_nb.mve import (
    ParsedMveCategory,
    parlay_game_group,
    sports_game_key,
)
from lobster_nb.parlay import (
    kalshi_taker_fee,
    quote_mid,
    round4,
    round6,
)
from lobster_nb.parlay_backtest import (
    combo_category,
    fetched_ms,
    group_by_ticker,
    ticker_settlement,
)

GameSlice = Literal["same_game", "cross_game"]

# Loader parity: isOpenCombo treats settled|finalized|closed as not open.
CLOSED_STATUS_RE = re.compile(r"^(settled|finalized|closed)$", re.IGNORECASE)
HYDRATE_CHUNK = 100
LEG_MIN_ASK = 0.02


@dataclass(frozen=True)
class LegQuote:
    """One leg's as-of YES book."""

    market_ticker: str
    event_ticker: str | None
    game_key: str
    title: str
    ask: float  # YES ask
    bid: float | None
    mid: float  # p-hat
    cost: float  # ask + taker fee
    volume: float
    close_time: str | None
    quoted_at: str | None


@dataclass(frozen=True)
class RolledParlay:
    """k legs bought YES at ask, rolled. multiple = 1 / prod(cost_i)."""

    legs: tuple[LegQuote, ...]
    game_group: GameSlice
    cost: float
    multiple: float
    p_indep: float
    settlement: int | None = None  # 1 all hit, 0 else, None ungraded
    graded: bool = False
    settlement_sources: tuple[str, ...] = field(default_factory=tuple)


def _iso_ms(raw: Any) -> float | None:
    """Parse an ISO timestamp (or None) to epoch ms. Returns None if absent."""
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw.timestamp() * 1000
    text = str(raw).strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text).timestamp() * 1000
    except ValueError:
        return None


def _is_open_status(status: str | None) -> bool:
    return not CLOSED_STATUS_RE.match(str(status or ""))


def last_quote_before(
    snaps: list[dict[str, Any]],
    at_ms: float,
    *,
    require_ask: bool = True,
) -> dict[str, Any] | None:
    """Last tradable hourly quote at or before ``at_ms`` of an open market.

    No-leakage gates: the snapshot's status must be open, the market must not
    have closed before ``at_ms``, and any settlement row printed before
    ``at_ms`` disqualifies the ticker entirely (it resolved too early).
    Settlement rows fetched after the quote are fine — that is the grade.
    """
    best: dict[str, Any] | None = None
    best_ms = -1.0
    for row in snaps:
        source = str(row.get("source") or "").lower()
        if source == "kalshi_settlement":
            # A settlement printed before the as-of time means the market
            # resolved too early to bet at as-of.
            if fetched_ms(row) < at_ms:
                return None
            continue
        if source in ("kalshi_parlay_fill", "kalshi_rfq"):
            continue
        if not _is_open_status(row.get("status")):
            continue
        close_ms = _iso_ms(row.get("close_time"))
        if close_ms is not None and close_ms <= at_ms:
            continue
        row_ms = fetched_ms(row)
        if row_ms <= 0 or row_ms > at_ms:
            continue
        if require_ask:
            ask = row.get("yes_ask")
            if ask is None or not isfinite(ask) or not (0 < ask < 1):
                continue
        else:
            mid = quote_mid(
                row.get("yes_bid"), row.get("yes_ask"), row.get("yes_last")
            )
            if mid is None or not (0 < mid < 1):
                continue
        if row_ms > best_ms:
            best_ms = row_ms
            best = row
    return best


def _leg_from_row(ticker: str, row: dict[str, Any]) -> LegQuote | None:
    ask = row.get("yes_ask")
    mid = quote_mid(row.get("yes_bid"), row.get("yes_ask"), row.get("yes_last"))
    if ask is None or mid is None or not (0 < ask < 1) or not (0 < mid < 1):
        return None
    event_ticker = row.get("event_ticker")
    return LegQuote(
        market_ticker=ticker,
        event_ticker=event_ticker,
        game_key=sports_game_key(ticker, event_ticker),
        title=row.get("title") or ticker,
        ask=ask,
        bid=row.get("yes_bid"),
        mid=mid,
        cost=round6(ask + kalshi_taker_fee(ask)),
        volume=row.get("volume") or 0.0,
        close_time=row.get("close_time"),
        quoted_at=row.get("fetched_at"),
    )


def leg_universe(
    markets: list[dict[str, Any]],
    at_ms: float,
    *,
    max_leg_ask: float,
    max_legs_per_game: int,
) -> tuple[list[LegQuote], list[str]]:
    """As-of leg universe: tickers referenced as combo legs, open at ``at_ms``.

    Ranked per game by lifetime volume, capped at ``max_legs_per_game``.
    """
    by_ticker = group_by_ticker(markets)
    leg_tickers: set[str] = set()
    for ticker, snaps in by_ticker.items():
        parsed = combo_category(snaps)
        if parsed is None:
            continue
        for spec in parsed.legs:
            leg_tickers.add(spec.market_ticker)
    legs: list[LegQuote] = []
    for ticker in sorted(leg_tickers):
        row = last_quote_before(by_ticker.get(ticker, []), at_ms)
        if row is None:
            continue
        leg = _leg_from_row(ticker, row)
        if leg is None:
            continue
        if leg.ask < LEG_MIN_ASK or leg.ask > max_leg_ask:
            continue
        legs.append(leg)
    by_game: dict[str, list[LegQuote]] = {}
    for leg in legs:
        by_game.setdefault(leg.game_key, []).append(leg)
    kept: list[LegQuote] = []
    for game in sorted(by_game):
        pool = sorted(
            by_game[game], key=lambda l: (-l.volume, l.market_ticker)
        )
        kept.extend(pool[: max(0, max_legs_per_game)])
    notes = [
        f"{len(leg_tickers)} referenced leg tickers; {len(legs)} had an open "
        f"tradable as-of quote with ask in [{LEG_MIN_ASK:.2f}, {max_leg_ask:.2f}]; "
        f"{len(by_game)} games, capped at {max_legs_per_game} legs/game by volume.",
    ]
    return kept, notes


def _cost_band(target_multiple: float, band_tol: float) -> tuple[float, float]:
    """Parlay cost window for [target/tol, target*tol] payout multiples."""
    lo_multiple = target_multiple / band_tol
    hi_multiple = target_multiple * band_tol
    return 1.0 / hi_multiple, 1.0 / lo_multiple


def _parlay_from(legs: tuple[LegQuote, ...], game_group: GameSlice) -> RolledParlay:
    cost = 1.0
    p_indep = 1.0
    for leg in legs:
        cost *= leg.cost
        p_indep *= leg.mid
    return RolledParlay(
        legs=legs,
        game_group=game_group,
        cost=round6(cost),
        multiple=round4(1.0 / cost),
        p_indep=round6(p_indep),
    )


def build_same_game_parlays(
    legs: list[LegQuote],
    k: int,
    *,
    target_multiple: float,
    band_tol: float,
    per_game_cap: int,
) -> list[RolledParlay]:
    """All in-band k-leg combinations within each game, volume-ranked, capped."""
    if k < 2:
        return []
    lo_cost, hi_cost = _cost_band(target_multiple, band_tol)
    by_game: dict[str, list[LegQuote]] = {}
    for leg in legs:
        by_game.setdefault(leg.game_key, []).append(leg)
    out: list[RolledParlay] = []
    for game in sorted(by_game):
        pool = sorted(by_game[game], key=lambda l: l.cost)
        candidates: list[RolledParlay] = []
        for combo in combinations(pool, k):
            cost = 1.0
            for leg in combo:
                cost *= leg.cost
            if not (lo_cost <= cost <= hi_cost):
                continue
            candidates.append(_parlay_from(combo, "same_game"))
        candidates.sort(
            key=lambda p: (-sum(l.volume for l in p.legs), p.legs[0].market_ticker)
        )
        out.extend(candidates[: max(0, per_game_cap)])
    return out


def build_cross_game_parlays(
    legs: list[LegQuote],
    k: int,
    *,
    target_multiple: float,
    band_tol: float,
    cap: int,
    rng_seed: int = 42,
) -> list[RolledParlay]:
    """Independence control: k legs from k distinct games in the same band.

    Randomized greedy matching toward per-leg cost ``target_cost**(1/k)`` so
    the control faces the same payout band as the same-game book.
    """
    if k < 2:
        return []
    lo_cost, hi_cost = _cost_band(target_multiple, band_tol)
    by_game: dict[str, list[LegQuote]] = {}
    for leg in legs:
        by_game.setdefault(leg.game_key, []).append(leg)
    games = sorted(by_game)
    if len(games) < k:
        return []
    target_cost = 1.0 / target_multiple
    per_leg = target_cost ** (1.0 / k)
    rng = random.Random(rng_seed)
    seen: set[frozenset[str]] = set()
    out: list[RolledParlay] = []
    attempts = 0
    max_attempts = max(1, cap) * 40
    while len(out) < cap and attempts < max_attempts:
        attempts += 1
        picked_games = rng.sample(games, k)
        chosen: list[LegQuote] = []
        for game in picked_games:
            pool = sorted(by_game[game], key=lambda l: abs(l.cost - per_leg))
            chosen.append(pool[rng.randrange(min(3, len(pool)))])
        key = frozenset(l.market_ticker for l in chosen)
        if len(key) != k or key in seen:
            continue
        cost = 1.0
        for leg in chosen:
            cost *= leg.cost
        if not (lo_cost <= cost <= hi_cost):
            continue
        seen.add(key)
        out.append(_parlay_from(tuple(chosen), "cross_game"))
    return out


def hydrate_ticker_settlements(
    tickers: list[str],
    get_json_fn: Any,
    hydrated: dict[str, int] | None = None,
    max_tickers: int | None = None,
) -> tuple[dict[str, int], int]:
    """GET /markets?tickers= for ungraded tickers. Settled/finalized markets
    with a yes/no ``result`` only; everything else stays ungraded. Returns the
    merged map plus the count fetched this run."""
    from urllib.parse import quote

    known = dict(hydrated or {})
    missing = [t for t in dict.fromkeys(tickers) if t not in known]
    if max_tickers is not None:
        missing = missing[: max(0, max_tickers)]
    fetched = 0
    for i in range(0, len(missing), HYDRATE_CHUNK):
        batch = missing[i : i + HYDRATE_CHUNK]
        result = get_json_fn(f"/markets?tickers={quote(','.join(batch))}&limit=1000")
        nested = (result.get("json") or {}).get("markets") if isinstance(result, dict) else None
        if not isinstance(nested, list):
            continue
        for raw in nested:
            if not isinstance(raw, dict):
                continue
            status = str(raw.get("status") or "").strip().lower()
            if status not in ("settled", "finalized"):
                continue
            result_yes = str(raw.get("result") or "").strip().lower()
            if result_yes not in ("yes", "no"):
                continue
            ticker = str(raw.get("ticker") or "").strip().upper()
            if not ticker or ticker in known:
                continue
            known[ticker] = 1 if result_yes == "yes" else 0
            fetched += 1
    return known, fetched


def grade_parlay(
    parlay: RolledParlay,
    by_ticker: dict[str, list[dict[str, Any]]],
    hydrated: dict[str, int] | None = None,
) -> RolledParlay:
    """Fill settlement/graded from lake rows first, hydration memo second.

    Lake grading requires the settlement row to be fetched after the leg's
    quote (``ticker_settlement`` with the quote's timestamp) — no leakage.
    ``by_ticker`` is the tape grouped once (see ``grade_parlays``); grouping
    per parlay is quadratic against the whole lake tape.
    """
    grades = hydrated or {}
    settlements: list[int] = []
    sources: list[str] = []
    for leg in parlay.legs:
        quote_ms = _iso_ms(leg.quoted_at) or 0.0
        lake_yes = ticker_settlement(by_ticker.get(leg.market_ticker, []), quote_ms)
        if lake_yes in (0, 1):
            settlements.append(lake_yes)
            sources.append("lake")
        elif grades.get(leg.market_ticker) in (0, 1):
            settlements.append(grades[leg.market_ticker])  # type: ignore[arg-type]
            sources.append("hydrated")
        else:
            sources.append("none")
    graded = len(sources) == len(parlay.legs) and "none" not in sources
    settlement: int | None = None
    if graded:
        settlement = 1 if all(s == 1 for s in settlements) else 0
    return RolledParlay(
        legs=parlay.legs,
        game_group=parlay.game_group,
        cost=parlay.cost,
        multiple=parlay.multiple,
        p_indep=parlay.p_indep,
        settlement=settlement,
        graded=graded,
        settlement_sources=tuple(sources),
    )


def grade_parlays(
    parlays: list[RolledParlay],
    markets: list[dict[str, Any]],
    hydrated: dict[str, int] | None = None,
) -> list[RolledParlay]:
    """Group the tape once, then grade every parlay against it."""
    by_ticker = group_by_ticker(markets)
    grades = hydrated or {}
    return [grade_parlay(p, by_ticker, grades) for p in parlays]

def summarize_parlays(parlays: list[RolledParlay]) -> list[dict[str, Any]]:
    """Realized P(all hit) vs the independence product, by game slice and k."""
    groups: dict[tuple[str, int], list[RolledParlay]] = {}
    for p in parlays:
        groups.setdefault((p.game_group, len(p.legs)), []).append(p)
    rows: list[dict[str, Any]] = []
    for (game_group, k), bucket in sorted(groups.items()):
        graded = [p for p in bucket if p.graded]
        hits = sum(1 for p in graded if p.settlement == 1)
        n = len(bucket)
        n_graded = len(graded)
        hit_rate = hits / n_graded if n_graded else None
        mean_multiple = sum(p.multiple for p in bucket) / n if n else None
        mean_p_indep = sum(p.p_indep for p in bucket) / n if n else None
        edge_pp = (
            round4((hit_rate - mean_p_indep) * 100)
            if hit_rate is not None and mean_p_indep is not None
            else None
        )
        ev_per_dollar = (
            round4(hit_rate * mean_multiple - 1)
            if hit_rate is not None and mean_multiple
            else None
        )
        ev_indep = (
            round4(sum(p.p_indep * p.multiple for p in bucket) / n - 1)
            if n
            else None
        )
        rows.append(
            {
                "game_slice": game_group,
                "legs": k,
                "n": n,
                "graded": n_graded,
                "hits": hits,
                "hit_rate": round4(hit_rate) if hit_rate is not None else None,
                "mean_multiple": round4(mean_multiple) if mean_multiple else None,
                "mean_p_indep": round6(mean_p_indep) if mean_p_indep else None,
                "realized_minus_indep_pp": edge_pp,
                "ev_per_dollar": ev_per_dollar,
                "ev_indep_per_dollar": ev_indep,
            }
        )
    return rows


def rolled_vs_listed(
    markets: list[dict[str, Any]],
    at_ms: float,
) -> tuple[list[dict[str, Any]], list[str]]:
    """k=2 same-game listed combos at ``at_ms``: combo ask vs rolling its legs.

    The listed combo market is the direct alternative to a rolled parlay, so
    this table answers "is it cheaper to buy the combo or roll the legs?".
    Side-adjusted leg cost: ``yes`` → ask + fee, ``no`` → (1 − yes_bid) + fee.
    """
    by_ticker = group_by_ticker(markets)
    rows: list[dict[str, Any]] = []
    combos_seen = 0
    for ticker, snaps in sorted(by_ticker.items()):
        parsed: ParsedMveCategory | None = combo_category(snaps)
        if parsed is None or len(parsed.legs) != 2:
            continue
        combo_row = last_quote_before(snaps, at_ms, require_ask=False)
        if combo_row is None:
            continue
        leg_specs = list(parsed.legs)
        games = [
            sports_game_key(spec.market_ticker, spec.event_ticker)
            for spec in leg_specs
        ]
        if parlay_game_group(games) != "same_game":
            continue
        combos_seen += 1
        combo_ask = combo_row.get("yes_ask")
        leg_costs: list[float | None] = []
        leg_labels: list[str] = []
        ok = True
        for spec in leg_specs:
            leg_row = last_quote_before(by_ticker.get(spec.market_ticker, []), at_ms)
            if leg_row is None:
                ok = False
                break
            price = (
                leg_row.get("yes_ask")
                if spec.side == "yes"
                else (
                    1 - leg_row.get("yes_bid")
                    if leg_row.get("yes_bid") is not None
                    else None
                )
            )
            if price is None or not (0 < price < 1):
                ok = False
                break
            leg_costs.append(price + kalshi_taker_fee(price))
            leg_labels.append(f"{spec.side}:{spec.market_ticker}")
        if not ok or combo_ask is None or not (0 < combo_ask < 1):
            continue
        combo_cost = combo_ask + kalshi_taker_fee(combo_ask)
        rolled_cost = 1.0
        for c in leg_costs:
            rolled_cost *= c
        rows.append(
            {
                "combo_ticker": ticker,
                "legs": ";".join(leg_labels),
                "combo_ask": round4(combo_ask),
                "combo_cost": round6(combo_cost),
                "rolled_leg_cost": round6(rolled_cost),
                "rolled_minus_combo": round6(rolled_cost - combo_cost),
                "combo_multiple": round4(1.0 / combo_cost),
                "rolled_multiple": round4(1.0 / rolled_cost),
                "quoted_at": combo_row.get("fetched_at"),
            }
        )
    notes = [
        f"{combos_seen} same-game two-leg combos had an open as-of quote; "
        f"{len(rows)} also had both legs priced at as-of."
    ]
    return rows, notes


def self_check() -> list[str]:
    """Offline invariant checks. Returns error strings (empty = pass)."""
    errors: list[str] = []

    # Taker fee port sanity.
    fee = kalshi_taker_fee(0.18)
    if abs(fee - 0.07 * 0.18 * 0.82) > 1e-6:
        errors.append(f"taker fee drifted: {fee}")

    # Band math: two 18c legs net of fees land inside a 30x ±25% band.
    lo, hi = _cost_band(30.0, 1.25)
    cost = (0.18 + kalshi_taker_fee(0.18)) ** 2
    if not (lo <= cost <= hi):
        errors.append(f"two-leg 18c cost {cost:.4f} outside band [{lo:.4f}, {hi:.4f}]")
    if abs(_cost_band(30.0, 1.0)[0] - _cost_band(30.0, 1.0)[1]) > 1e-12:
        errors.append("tol=1 band should be a point")

    def snap(
        ticker: str,
        at: str,
        *,
        ask: float | None = 0.18,
        bid: float | None = 0.15,
        status: str = "active",
        close: str = "2026-09-14T01:30:00Z",
        source: str = "kalshi",
        event: str | None = "KXTEST-26SEP13AB",
    ) -> dict[str, Any]:
        return {
            "market_ticker": ticker,
            "event_ticker": event,
            "title": ticker,
            "yes_bid": bid,
            "yes_ask": ask,
            "yes_last": None,
            "status": status,
            "close_time": close,
            "fetched_at": at,
            "source": source,
        }

    t0 = datetime(2026, 9, 13, 12, 0, 0, tzinfo=timezone.utc).timestamp() * 1000
    # Leakage gates: post-as-of quote, closed status, resolved-early, closed-before-asof.
    if last_quote_before([snap("A", "2026-09-13T13:00:00Z")], t0) is not None:
        errors.append("quote after as-of leaked in")
    if last_quote_before([snap("A", "2026-09-13T10:00:00Z", status="finalized")], t0) is not None:
        errors.append("closed-status quote leaked in")
    if last_quote_before(
        [
            snap("A", "2026-09-13T10:00:00Z"),
            snap("A", "2026-09-13T11:00:00Z", source="kalshi_settlement"),
        ],
        t0,
    ) is not None:
        errors.append("pre-as-of settlement did not disqualify the ticker")
    if last_quote_before(
        [snap("A", "2026-09-13T10:00:00Z", close="2026-09-13T11:30:00Z")], t0
    ) is not None:
        errors.append("market closing before as-of leaked in")
    good = last_quote_before([snap("A", "2026-09-13T10:00:00Z")], t0)
    if good is None or good["market_ticker"] != "A":
        errors.append("valid pre-close quote rejected")
    # Latest quote wins.
    later = last_quote_before(
        [snap("A", "2026-09-13T09:00:00Z"), snap("A", "2026-09-13T11:00:00Z")], t0
    )
    if later is None or fetched_ms(later) != datetime.fromisoformat(
        "2026-09-13T11:00:00+00:00"
    ).timestamp() * 1000:
        errors.append("latest pre-as-of quote not chosen")

    # Same-game vs cross-game construction.
    legs: list[LegQuote] = []
    for i, (tk, cost_ask) in enumerate(
        [("A1", 0.18), ("A2", 0.19), ("B1", 0.18), ("B2", 0.19)]
    ):
        row = snap(tk, "2026-09-13T11:00:00Z", ask=cost_ask, event="KXTEST-26SEP13AB" if tk.startswith("A") else "KXTEST-26SEP13CD")
        leg = _leg_from_row(tk, row)
        if leg is None:
            errors.append(f"leg {tk} failed to build")
            continue
        legs.append(leg)
    same = build_same_game_parlays(
        legs, 2, target_multiple=30.0, band_tol=1.25, per_game_cap=10
    )
    if same and not all(
        30.0 / 1.25 <= p.multiple <= 30.0 * 1.25 for p in same
    ):
        errors.append("same-game parlay multiple outside band")
    if same and not all(
        len({l.game_key for l in p.legs}) == 1 for p in same
    ):
        errors.append("same-game parlay spans games")
    cross = build_cross_game_parlays(
        legs, 2, target_multiple=30.0, band_tol=1.25, cap=20
    )
    if cross and not all(
        len({l.game_key for l in p.legs}) == len(p.legs) for p in cross
    ):
        errors.append("cross-game parlay repeats a game")

    # Grading: all-hit vs miss vs ungraded.
    def graded_parlay(settlements: dict[str, int]) -> RolledParlay:
        pl = _parlay_from((legs[0], legs[1]), "same_game")
        rows: list[dict[str, Any]] = []
        for tk, s in settlements.items():
            rows.append(snap(tk, "2026-09-13T11:00:00Z"))
            rows.append(
                {
                    **snap(
                        tk,
                        "2026-09-14T05:00:00Z",
                        source="kalshi_settlement",
                        bid=float(s),
                    ),
                    "market_ticker": tk,
                    "yes_last": float(s),
                }
            )
        return grade_parlay(pl, group_by_ticker(rows), {})

    hit = graded_parlay({"A1": 1, "A2": 1})
    if hit.settlement != 1 or not hit.graded:
        errors.append(f"all-hit parlay graded {hit.settlement}")
    miss = graded_parlay({"A1": 1, "A2": 0})
    if miss.settlement != 0:
        errors.append(f"miss parlay graded {miss.settlement}")
    ungraded = graded_parlay({"A1": 1})
    if ungraded.graded:
        errors.append("parlay with a missing leg grade marked graded")

    return errors
