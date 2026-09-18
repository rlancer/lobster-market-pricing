"""Sports parlay books + quote math. Port of kalshi-parlay-filter.ts + taker fee."""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from math import isfinite, sqrt
from typing import Any, Callable, Literal, Sequence

from lobster_nb.mve import Side

PARLAY_MIN_CORR_ROOM = 0.15
PARLAY_MAX_SPREAD = 0.08
PARLAY_MAX_ASK_OVER_INDEP = 0.02
PARLAY_MAX_ABS_PHI = 0.15
PARLAY_MAX_CONTRACTS = 10
PARLAY_UNDERDOG_MAX_COST = 0.50
PARLAY_MIN_PAYOUT_MULTIPLE = 35.0
PARLAY_LONGSHOT_MAX_COST = 1.0 / PARLAY_MIN_PAYOUT_MULTIPLE

BOOK_CORR_ROOM = "corr_room_yes"
BOOK_UNDERDOG = "same_game_underdog"
BOOK_LONGSHOT = "cross_game_longshot"
BOOKS: tuple[str, ...] = (BOOK_CORR_ROOM, BOOK_UNDERDOG, BOOK_LONGSHOT)

ParlayBookId = Literal["corr_room_yes", "same_game_underdog", "cross_game_longshot"]
Action = Literal["buy_yes", "skip"]


@dataclass(frozen=True)
class ParlayKnobs:
    """Production defaults. Notebook widgets override one field at a time."""

    corr_room_floor: float = PARLAY_MIN_CORR_ROOM
    max_ask_over_indep: float = PARLAY_MAX_ASK_OVER_INDEP
    max_abs_phi: float = PARLAY_MAX_ABS_PHI
    underdog_max_cost: float = PARLAY_UNDERDOG_MAX_COST
    longshot_multiple: float = PARLAY_MIN_PAYOUT_MULTIPLE
    max_spread: float = PARLAY_MAX_SPREAD
    persist_n_minutes: int = 0
    contracts: int = PARLAY_MAX_CONTRACTS

    @property
    def longshot_max_cost(self) -> float:
        if self.longshot_multiple <= 0:
            return 0.0
        return 1.0 / self.longshot_multiple

    def params_json(self) -> dict[str, Any]:
        return asdict(self)


PRODUCTION_KNOBS = ParlayKnobs()

# One-at-a-time perturbations vs production — not a grid search.
PERTURBATIONS: tuple[tuple[str, ParlayKnobs], ...] = (
    ("corr_room_floor+0.05", replace(PRODUCTION_KNOBS, corr_room_floor=0.20)),
    ("max_ask_over_indep+0.02", replace(PRODUCTION_KNOBS, max_ask_over_indep=0.04)),
    ("max_abs_phi+0.05", replace(PRODUCTION_KNOBS, max_abs_phi=0.20)),
    ("underdog_max_cost=0.40", replace(PRODUCTION_KNOBS, underdog_max_cost=0.40)),
    ("longshot_multiple=25", replace(PRODUCTION_KNOBS, longshot_multiple=25.0)),
    ("max_spread=0.10", replace(PRODUCTION_KNOBS, max_spread=0.10)),
)


@dataclass(frozen=True)
class ParlayQuoteInput:
    market_ticker: str
    same_game: bool
    sides: tuple[Side, ...]
    p: float
    q: float
    yes_bid: float
    yes_ask: float
    quote_id: str | None = None
    cross_game: bool = False


@dataclass(frozen=True)
class ParlayQuoteDecision:
    ok: bool
    reasons: tuple[str, ...]
    independence: float
    corr_room: float
    spread: float
    ask_vs_indep: float
    phi: float | None
    payout_multiple: float
    action: Action


def clamp01(n: float) -> float:
    if not isfinite(n):
        return 0.0
    return min(1.0, max(0.0, n))


def round4(n: float) -> float:
    return round(n * 1e4) / 1e4


def round6(n: float) -> float:
    return round(n * 1e6) / 1e6


def parse_kalshi_number(raw: Any) -> float | None:
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)) and isfinite(float(raw)):
        return float(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            n = float(raw)
        except ValueError:
            return None
        return n if isfinite(n) else None
    return None


def independence_joint(p: float, q: float) -> float:
    return clamp01(p) * clamp01(q)


def corr_room(p: float, q: float) -> float:
    pp = clamp01(p)
    qq = clamp01(q)
    return max(0.0, min(pp, qq) - pp * qq)


def independence_joint_n(probs: Sequence[float]) -> float:
    """n-leg independence joint: product of clamped leg probabilities."""
    out = 1.0
    for p in probs:
        out *= clamp01(p)
    return out


def frechet_room_n(probs: Sequence[float]) -> float:
    """n-leg Fréchet room: P(all) upper bound (min p_i) minus the independence
    joint. ``frechet_room_n([p, q])`` equals the two-leg ``corr_room``."""
    if not probs:
        return 0.0
    return max(0.0, min(clamp01(p) for p in probs) - independence_joint_n(probs))


def bernoulli_phi(p: float, q: float, joint: float) -> float | None:
    pp = clamp01(p)
    qq = clamp01(q)
    den = sqrt(pp * (1 - pp) * qq * (1 - qq))
    if not (den > 0):
        return None
    return (joint - pp * qq) / den


def parlay_payout_multiple(ask: float) -> float:
    if not (isfinite(ask) and ask > 0):
        return 0.0
    return 1.0 / ask


def same_side(sides: tuple[Side, ...] | list[Side]) -> bool:
    if len(sides) < 2:
        return False
    return all(side == sides[0] for side in sides)


def kalshi_taker_fee(price: float) -> float:
    """≈ 7% of expected earnings on a $1 contract. Port of worker kalshiTakerFee."""
    p = clamp01(price)
    return round6(0.07 * p * (1 - p))


def _last_in_open_unit(last: float | None) -> float | None:
    if last is None or not isfinite(last) or last <= 0 or last >= 1:
        return None
    return last


def quote_mid(
    yes_bid: float | None,
    yes_ask: float | None,
    yes_last: float | None = None,
) -> float | None:
    bid = yes_bid
    ask = yes_ask
    if (
        bid is not None
        and ask is not None
        and isfinite(bid)
        and isfinite(ask)
        and bid >= 0
        and ask <= 1
        and ask >= bid
    ):
        empty_rfq = (bid == 0 and ask == 0) or (bid == 0 and ask == 1)
        if empty_rfq:
            return _last_in_open_unit(yes_last)
        return round6((bid + ask) / 2)
    last = _last_in_open_unit(yes_last)
    if last is not None:
        return last
    if yes_last is not None and isfinite(yes_last) and 0 <= yes_last <= 1:
        if yes_last in (0, 1):
            return yes_last
    if bid is not None and isfinite(bid) and 0 < bid < 1:
        return bid
    if ask is not None and isfinite(ask) and 0 < ask < 1:
        return ask
    return None


def has_tradable_quote(
    yes_bid: float | None,
    yes_ask: float | None,
    yes_last: float | None = None,
) -> bool:
    mid = quote_mid(yes_bid, yes_ask, yes_last)
    return mid is not None and 0 < mid < 1


def is_two_sided(yes_bid: float | None, yes_ask: float | None) -> bool:
    return (
        yes_bid is not None
        and yes_ask is not None
        and isfinite(yes_bid)
        and isfinite(yes_ask)
        and yes_bid > 0
        and yes_ask < 1
        and yes_ask >= yes_bid
    )


def _finish_quote(
    inp: ParlayQuoteInput,
    extra: Callable[[dict[str, Any], list[str]], None],
    game: Literal["same_game", "cross_game"] = "same_game",
    knobs: ParlayKnobs = PRODUCTION_KNOBS,
) -> ParlayQuoteDecision:
    reasons: list[str] = []
    p = clamp01(inp.p)
    q = clamp01(inp.q)
    independence = independence_joint(p, q)
    room = corr_room(p, q)
    spread = inp.yes_ask - inp.yes_bid
    ask_vs_indep = inp.yes_ask - independence
    phi = bernoulli_phi(p, q, inp.yes_ask)
    payout_multiple = parlay_payout_multiple(inp.yes_ask)

    if len(inp.sides) != 2:
        reasons.append("not_two_leg")
    if game == "same_game" and not inp.same_game:
        reasons.append("not_same_game")
    if game == "cross_game" and not inp.cross_game:
        reasons.append("not_cross_game")
    if not same_side(inp.sides):
        reasons.append("mixed_side")
    if not (isfinite(spread) and spread >= 0 and spread <= knobs.max_spread + 1e-12):
        reasons.append("spread")
    if not (isfinite(inp.yes_ask) and 0 < inp.yes_ask < 1):
        reasons.append("ask")
    extra(
        {
            "yes_ask": inp.yes_ask,
            "corr_room": room,
            "ask_vs_indep": ask_vs_indep,
            "phi": phi,
        },
        reasons,
    )
    if not inp.quote_id:
        reasons.append("no_quote_id")

    ok = len(reasons) == 0
    return ParlayQuoteDecision(
        ok=ok,
        reasons=tuple(reasons),
        independence=independence,
        corr_room=room,
        spread=spread,
        ask_vs_indep=ask_vs_indep,
        phi=phi,
        payout_multiple=payout_multiple,
        action="buy_yes" if ok else "skip",
    )


def evaluate_corr_room_yes(
    inp: ParlayQuoteInput,
    knobs: ParlayKnobs = PRODUCTION_KNOBS,
) -> ParlayQuoteDecision:
    def extra(stats: dict[str, Any], reasons: list[str]) -> None:
        if not (stats["corr_room"] >= knobs.corr_room_floor - 1e-12):
            reasons.append("corr_room")
        if not (stats["ask_vs_indep"] <= knobs.max_ask_over_indep + 1e-12):
            reasons.append("ask_vs_indep")
        phi = stats["phi"]
        if phi is None or abs(phi) >= knobs.max_abs_phi:
            reasons.append("phi")

    return _finish_quote(inp, extra, "same_game", knobs)


def evaluate_underdog_yes(
    inp: ParlayQuoteInput,
    knobs: ParlayKnobs = PRODUCTION_KNOBS,
) -> ParlayQuoteDecision:
    def extra(stats: dict[str, Any], reasons: list[str]) -> None:
        ask = stats["yes_ask"]
        if not (isfinite(ask) and ask <= knobs.underdog_max_cost + 1e-12):
            reasons.append("underdog_cost")

    return _finish_quote(inp, extra, "same_game", knobs)


def evaluate_longshot_yes(
    inp: ParlayQuoteInput,
    knobs: ParlayKnobs = PRODUCTION_KNOBS,
) -> ParlayQuoteDecision:
    def extra(stats: dict[str, Any], reasons: list[str]) -> None:
        ask = stats["yes_ask"]
        if not (isfinite(ask) and ask <= knobs.longshot_max_cost + 1e-12):
            reasons.append("payout")
        if not (stats["ask_vs_indep"] <= 1e-12):
            reasons.append("ask_vs_indep")

    return _finish_quote(inp, extra, "cross_game", knobs)


def evaluate_parlay_executor_quote(
    inp: ParlayQuoteInput,
    book: str = BOOK_UNDERDOG,
    knobs: ParlayKnobs = PRODUCTION_KNOBS,
) -> ParlayQuoteDecision:
    if book == BOOK_CORR_ROOM:
        return evaluate_corr_room_yes(inp, knobs)
    if book == BOOK_LONGSHOT:
        return evaluate_longshot_yes(inp, knobs)
    return evaluate_underdog_yes(inp, knobs)


def fill_pnl(
    settlement: int,
    yes_bid: float,
    yes_ask: float,
    contracts: int,
) -> tuple[float, float]:
    """YES-at-ask vs BUY NO at 1 − yes_bid, after taker fees, `contracts` face."""
    no_ask = 1 - yes_bid
    yes = contracts * (settlement - yes_ask - kalshi_taker_fee(yes_ask))
    no = contracts * ((1 - settlement) - no_ask - kalshi_taker_fee(no_ask))
    return round4(yes), round4(no)


def live_fill_pnl(
    fill_side: Side,
    settlement: int,
    yes_price: float,
    no_price: float,
    contracts: float,
    fee_total: float,
) -> tuple[float, float]:
    yes_fee = contracts * kalshi_taker_fee(yes_price)
    if fill_side == "yes":
        actual = contracts * (settlement - yes_price) - fee_total
    else:
        actual = contracts * ((1 - settlement) - no_price) - fee_total
    yes_cf = contracts * (settlement - yes_price) - yes_fee
    return round4(actual), round4(yes_cf)


KALSHI_SETTLEMENT_SOURCE = "kalshi_settlement"
KALSHI_RFQ_SOURCE = "kalshi_rfq"
KALSHI_PARLAY_FILL_SOURCE = "kalshi_parlay_fill"
PARLAY_FILL_YES = "buy_yes"
PARLAY_FILL_NO = "buy_no"


def is_kalshi_settlement_source(source: str | None) -> bool:
    return str(source or "").strip().lower() == KALSHI_SETTLEMENT_SOURCE


def is_kalshi_parlay_fill_source(source: str | None) -> bool:
    return str(source or "").strip().lower() == KALSHI_PARLAY_FILL_SOURCE


def is_kalshi_settled_status(status: str | None) -> bool:
    return bool(re_fullmatch_settled(status))


def re_fullmatch_settled(status: str | None) -> bool:
    import re

    return bool(re.fullmatch(r"(settled|finalized)", str(status or "").strip(), re.I))


def kalshi_result_yes(result: Any) -> Literal[0, 1] | None:
    raw = str(result or "").strip().lower()
    if raw in ("yes", "1"):
        return 1
    if raw in ("no", "0"):
        return 0
    return None


def looks_like_settlement_print(
    bid: float | None,
    ask: float | None,
    last: float | None,
) -> bool:
    def binary(v: float | None) -> bool:
        return v is None or v in (0, 1)

    if last not in (0, 1):
        return False
    return binary(bid) and binary(ask)


def settlement_yes(row: dict[str, Any]) -> Literal[0, 1] | None:
    from_result = kalshi_result_yes(row.get("result"))
    status = row.get("status")
    source = row.get("source")
    if from_result is not None and (
        is_kalshi_settled_status(status) or is_kalshi_settlement_source(source)
    ):
        return from_result
    last = parse_kalshi_number(row.get("yes_last"))
    if last not in (0, 1):
        return None
    bid = parse_kalshi_number(row.get("yes_bid"))
    ask = parse_kalshi_number(row.get("yes_ask"))
    if (
        is_kalshi_settlement_source(source)
        or is_kalshi_settled_status(status)
        or looks_like_settlement_print(bid, ask, last)
    ):
        return 0 if last == 0 else 1
    return None


def infer_combo_settlement(
    legs: list[tuple[Side, Literal[0, 1] | None]],
) -> Literal[0, 1] | None:
    if len(legs) < 2:
        return None
    all_hit = True
    for side, settle in legs:
        if settle not in (0, 1):
            return None
        selected_hit = settle == 1 if side == "yes" else settle == 0
        if not selected_hit:
            all_hit = False
    return 1 if all_hit else 0


def parse_fill_side(subtitle: str | None) -> Side | None:
    raw = str(subtitle or "").strip().lower()
    if raw in (PARLAY_FILL_YES, "yes"):
        return "yes"
    if raw in (PARLAY_FILL_NO, "no"):
        return "no"
    return None


def self_check() -> list[str]:
    """Mirror loader/src/kalshi-parlay-filter.test.ts fixtures. Returns error strings."""
    errors: list[str] = []

    def check(cond: bool, msg: str) -> None:
        if not cond:
            errors.append(msg)

    d = evaluate_corr_room_yes(
        ParlayQuoteInput(
            "FERGUSON-DART",
            True,
            ("no", "no"),
            0.63,
            0.715,
            0.416,
            0.451,
            "q-ferg",
        )
    )
    check(d.corr_room > PARLAY_MIN_CORR_ROOM, "ferg corr_room")
    check(d.ok and d.action == "buy_yes" and d.reasons == (), "ferg should buy")

    mixed = evaluate_corr_room_yes(
        ParlayQuoteInput(
            "PICKENS-SKATTEBO",
            True,
            ("no", "yes"),
            0.525,
            0.235,
            0.102,
            0.121,
            "q-mix",
        )
    )
    check(not mixed.ok and "mixed_side" in mixed.reasons, "mixed_side")

    under = evaluate_parlay_executor_quote(
        ParlayQuoteInput(
            "FRECHET", True, ("yes", "yes"), 0.40, 0.49, 0.38, 0.41, "q-rho"
        ),
        BOOK_UNDERDOG,
    )
    check(under.ok, "underdog takes 41c")
    check(
        not evaluate_corr_room_yes(
            ParlayQuoteInput(
                "FRECHET", True, ("yes", "yes"), 0.40, 0.49, 0.38, 0.41, "q-rho"
            )
        ).ok,
        "corr_room skips Frechet quote",
    )

    fav = evaluate_parlay_executor_quote(
        ParlayQuoteInput(
            "FAVORITE", True, ("yes", "yes"), 0.80, 0.80, 0.58, 0.62, "q-fav"
        ),
        BOOK_UNDERDOG,
    )
    check("underdog_cost" in fav.reasons, "underdog_cost")

    ask = 119.99 / 4493
    long_ok = evaluate_parlay_executor_quote(
        ParlayQuoteInput(
            "KC-TB-SPREAD",
            False,
            ("yes", "yes"),
            0.48,
            0.16,
            0.02,
            ask,
            "q-combo",
            True,
        ),
        BOOK_LONGSHOT,
    )
    check(long_ok.ok, "longshot 37x")
    check(abs(long_ok.payout_multiple - 37.45) < 0.2, "payout ~37.45")

    skip_same = evaluate_parlay_executor_quote(
        ParlayQuoteInput(
            "SAME", True, ("yes", "yes"), 0.48, 0.16, 0.02, 0.0267, "q-same", False
        ),
        BOOK_LONGSHOT,
    )
    check("not_cross_game" in skip_same.reasons, "longshot same-game skip")

    check(abs(kalshi_taker_fee(0.5) - 0.07 * 0.5 * 0.5) < 1e-9, "taker fee 50c")
    check(quote_mid(0.61, 0.62, 0.5) == 0.615, "quote mid")
    check(quote_mid(0, 1, 0.4) == 0.4, "empty rfq uses last")
    check(not has_tradable_quote(1, 1, 1), "settlement not tradable")
    return errors
