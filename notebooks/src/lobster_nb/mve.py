"""Sports MVE category / leg parsers. Port of loader/src/kalshi-mve.ts."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

MVE_CATEGORY_PREFIX = "mve|"

SPORTS_SERIES_PREFIX = re.compile(
    r"^KX(NFL|NBA|MLB|NHL|MLS|WNBA|NCAA|NCAAF|NCAAB|NCAAW|CFB|CBB|EPL|UCL|UFC|ATP|WTA|PGA|FIFA|SOCCER|PARLAY)",
    re.I,
)

SPORTS_TEXT_RE = re.compile(
    r"\b(NFL|NBA|MLB|NHL|MLS|WNBA|NCAA|NCAAF|NCAAB|CFB|CBB|EPL|UCL|UFC|ATP|WTA|PGA|"
    r"FIFA|SOCCER|FOOTBALL|BASKETBALL|BASEBALL|HOCKEY|TENNIS|GOLF|MMA|SPORTS?|"
    r"RAVENS|JAGUARS|CHIEFS|BILLS|COWBOYS|YANKEES|LAKERS|CELTICS)\b",
    re.I,
)

CRYPTO_LEG_RE = re.compile(
    r"^KX(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE|ZEC|ADA|AVAX|DOT|LINK|MATIC|SHIB|PEPE|WIF|"
    r"SUI|APT|NEAR|TON|TRX|LTC|BCH|BONK|SEI|ONDO|TAO)(15M|D)?(?:-|$)",
    re.I,
)

SPORTS_GAME_SLUG_RE = re.compile(r"(\d{2}[A-Z]{3}\d{2}[A-Z]{6})")

MveLegKind = Literal["sports", "crypto", "other"]
MveTapeKind = Literal["sports", "crypto_mve", "mixed"]
GameGroup = Literal["same_game", "cross_game", "mixed"]
Side = Literal["yes", "no"]


@dataclass(frozen=True)
class MveSelectedLeg:
    event_ticker: str | None
    market_ticker: str
    side: Side


@dataclass(frozen=True)
class ParsedMveCategory:
    collection: str
    legs: tuple[MveSelectedLeg, ...]


def _as_record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _strip(raw: Any, default: str = "") -> str:
    return raw.strip() if isinstance(raw, str) else default


def series_ticker_from_market_ticker(ticker: str) -> str:
    t = ticker.strip().upper()
    m = re.match(r"^(KX[A-Z]+)", t)
    return m.group(1) if m else t


def mve_leg_kind(ticker: str) -> MveLegKind:
    t = ticker.strip().upper()
    if CRYPTO_LEG_RE.search(t):
        return "crypto"
    if SPORTS_SERIES_PREFIX.search(t):
        return "sports"
    return "other"


def mve_tape_kind(leg_tickers: list[str]) -> MveTapeKind:
    sports = False
    crypto = False
    for ticker in leg_tickers:
        kind = mve_leg_kind(ticker)
        if kind == "sports":
            sports = True
        elif kind == "crypto":
            crypto = True
    if sports and crypto:
        return "mixed"
    if crypto:
        return "crypto_mve"
    return "sports"


def parse_mve_selected_legs(raw: Any) -> list[MveSelectedLeg]:
    rec = _as_record(raw)
    legs = rec.get("mve_selected_legs") if rec else None
    if not isinstance(legs, list):
        return []
    out: list[MveSelectedLeg] = []
    seen: set[str] = set()
    for item in legs:
        leg = _as_record(item)
        if not leg:
            continue
        market_ticker = _strip(leg.get("market_ticker")).upper()
        if not market_ticker or market_ticker in seen:
            continue
        seen.add(market_ticker)
        side: Side = "no" if _strip(leg.get("side")).lower() == "no" else "yes"
        event_ticker = _strip(leg.get("event_ticker")).upper() or None
        out.append(MveSelectedLeg(event_ticker, market_ticker, side))
    return out


def mve_collection_ticker(raw: Any) -> str:
    rec = _as_record(raw)
    return _strip(rec.get("mve_collection_ticker") if rec else "").upper()


def _pack_category_token(raw: str) -> str:
    return raw.replace("|", "").replace("@", "").replace(",", "").upper()


def encode_mve_category(collection: str, legs: list[MveSelectedLeg]) -> str:
    col = _pack_category_token(collection or "unknown") or "UNKNOWN"
    packed = []
    for leg in legs:
        ticker = _pack_category_token(leg.market_ticker)
        event = _pack_category_token(leg.event_ticker or "")
        side = "no" if leg.side == "no" else "yes"
        packed.append(f"{side}:{ticker}@{event}" if event else f"{side}:{ticker}")
    return f"{MVE_CATEGORY_PREFIX}{col}|{','.join(packed)}"


def parse_mve_category(category: str | None) -> ParsedMveCategory | None:
    raw = (category or "").strip()
    if not raw.startswith(MVE_CATEGORY_PREFIX):
        return None
    rest = raw[len(MVE_CATEGORY_PREFIX) :]
    split = rest.find("|")
    if split < 0:
        return None
    collection = rest[:split].upper()
    packed = rest[split + 1 :]
    legs: list[MveSelectedLeg] = []
    seen: set[str] = set()
    for part in packed.split(","):
        idx = part.find(":")
        if idx < 0:
            continue
        side: Side = "no" if part[:idx].lower() == "no" else "yes"
        rest_leg = part[idx + 1 :].strip().upper()
        at = rest_leg.find("@")
        market_ticker = (rest_leg[:at] if at >= 0 else rest_leg).strip()
        event_ticker = rest_leg[at + 1 :].strip() or None if at >= 0 else None
        if not market_ticker or market_ticker in seen:
            continue
        seen.add(market_ticker)
        legs.append(MveSelectedLeg(event_ticker, market_ticker, side))
    if len(legs) < 2:
        return None
    return ParsedMveCategory(collection, tuple(legs))


def event_prefix_from_ticker(ticker: str) -> str:
    t = ticker.strip().upper()
    trimmed = re.sub(r"-[^-]+$", "", t)
    return trimmed or t


def sports_game_key(ticker: str, event_ticker: str | None = None) -> str:
    blob = f"{event_ticker or ''}-{ticker}".upper()
    game = SPORTS_GAME_SLUG_RE.search(blob)
    if game:
        return game.group(1)
    if event_ticker and event_ticker.strip():
        return event_ticker.strip().upper()
    return event_prefix_from_ticker(ticker)


def parlay_game_group(event_tickers: list[str]) -> GameGroup:
    events = list(dict.fromkeys(e.strip().upper() for e in event_tickers if e.strip()))
    if len(events) <= 1:
        return "same_game"
    if len(events) == len([e for e in event_tickers if e.strip()]):
        return "cross_game"
    return "mixed"


def _is_sports_two_leg(legs: list[MveSelectedLeg]) -> bool:
    if len(legs) != 2:
        return False
    tickers = [leg.market_ticker for leg in legs]
    if mve_tape_kind(tickers) != "sports":
        return False
    return all(mve_leg_kind(t) == "sports" for t in tickers)


def is_same_game_sports_two_leg(legs: list[MveSelectedLeg]) -> bool:
    if not _is_sports_two_leg(legs):
        return False
    games = [sports_game_key(leg.market_ticker, leg.event_ticker) for leg in legs]
    return parlay_game_group(games) == "same_game"


def is_cross_game_sports_two_leg(legs: list[MveSelectedLeg]) -> bool:
    if not _is_sports_two_leg(legs):
        return False
    games = [sports_game_key(leg.market_ticker, leg.event_ticker) for leg in legs]
    return parlay_game_group(games) == "cross_game"


def is_sports_parlay_candidate(raw: Any, investing_series: frozenset[str] | set[str]) -> bool:
    rec = _as_record(raw)
    if not rec:
        return False
    series = (
        _strip(rec.get("series_ticker")).upper()
        or series_ticker_from_market_ticker(_strip(rec.get("ticker")).upper())
    )
    if series and series in investing_series:
        return False
    legs = parse_mve_selected_legs(raw)
    if len(legs) < 2:
        return False
    tape = mve_tape_kind([leg.market_ticker for leg in legs])
    if tape == "crypto_mve":
        return False
    if tape in ("sports", "mixed"):
        return True
    collection = mve_collection_ticker(raw)
    blob = " ".join(
        [
            series,
            collection,
            _strip(rec.get("title")),
            _strip(rec.get("category")),
            _strip(rec.get("yes_sub_title")) or _strip(rec.get("subtitle")),
        ]
    )
    if SPORTS_TEXT_RE.search(blob):
        return True
    if SPORTS_SERIES_PREFIX.search(series) or SPORTS_SERIES_PREFIX.search(collection):
        return True
    return _strip(rec.get("category")).lower() == "sports"
