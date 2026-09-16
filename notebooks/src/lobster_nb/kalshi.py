"""Signed Kalshi Trade API helpers. Never log PEM material or key ids in full.

Read-only. This module only issues GET. It does not create RFQs, accept quotes,
or place orders.
"""

from __future__ import annotations

import base64
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from lobster_nb.env import load_repo_env, repo_root
from lobster_nb.mve import (
    encode_mve_category,
    is_sports_parlay_candidate,
    mve_collection_ticker,
    mve_tape_kind,
    parse_mve_selected_legs,
    series_ticker_from_market_ticker,
)
from lobster_nb.parlay import parse_kalshi_number

DEFAULT_API_BASE = "https://api.elections.kalshi.com/trade-api/v2"
USER_AGENT = "lobster-nb/0.1"
MIN_REQUEST_GAP_S = 0.4
_last_request_at = 0.0


def _pem_text() -> str | None:
    load_repo_env()
    inline = (os.environ.get("KALSHI_PRIVATE_KEY_PEM") or "").strip()
    if inline:
        return inline.replace("\\n", "\n")
    rel = (os.environ.get("KALSHI_PRIVATE_KEY_FILE") or "").strip()
    if not rel:
        return None
    candidate = Path(rel)
    search = [candidate] if candidate.is_absolute() else [
        repo_root() / rel,
        repo_root() / "loader" / rel,
        repo_root() / "loader" / Path(rel).name,
    ]
    for path in search:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    return None


def auth_configured() -> bool:
    load_repo_env()
    key_id = (os.environ.get("KALSHI_ACCESS_KEY_ID") or "").strip()
    return bool(key_id and _pem_text())


def sign_path(url: str) -> str:
    parsed = urlparse(url)
    if parsed.path:
        return parsed.path
    no_query = url.split("?", 1)[0]
    idx = no_query.find("/trade-api/")
    return no_query[idx:] if idx >= 0 else no_query


def api_base() -> str:
    load_repo_env()
    return (os.environ.get("KALSHI_API_BASE") or DEFAULT_API_BASE).rstrip("/")


def _pace() -> None:
    global _last_request_at
    wait = _last_request_at + MIN_REQUEST_GAP_S - time.time()
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.time()


def _url(path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    if not path.startswith("/"):
        path = "/" + path
    return api_base() + path


def get_json(path: str, timeout_s: float = 30.0, retries: int = 3) -> dict[str, Any]:
    """Signed GET. Never logs headers or secret values. GET only."""
    url = _url(path)
    last_error = "request failed"
    for attempt in range(retries):
        _pace()
        headers = auth_headers("GET", url) or {}
        headers["User-Agent"] = USER_AGENT
        try:
            response = httpx.get(url, headers=headers, timeout=timeout_s)
        except Exception as exc:
            last_error = str(exc)[:300]
            time.sleep(min(8, 1.5 * (attempt + 1)))
            continue
        if response.status_code in (429, 408, 500, 502, 503, 504):
            sleep_s = min(12.0, 2.0 * (attempt + 1))
            retry_after = response.headers.get("Retry-After")
            if retry_after:
                try:
                    sleep_s = min(12.0, max(sleep_s, float(retry_after)))
                except ValueError:
                    pass
            time.sleep(sleep_s)
            last_error = f"HTTP {response.status_code}"
            continue
        try:
            payload = response.json()
        except Exception:
            payload = None
        if not response.is_success:
            return {
                "ok": False,
                "status": response.status_code,
                "error": f"HTTP {response.status_code}",
                "json": payload if isinstance(payload, dict) else {},
            }
        if not isinstance(payload, dict):
            return {"ok": False, "status": response.status_code, "error": "non-object json", "json": {}}
        return {"ok": True, "status": response.status_code, "error": None, "json": payload}
    return {"ok": False, "status": None, "error": last_error, "json": {}}


def auth_headers(method: str, url: str, now_ms: int | None = None) -> dict[str, str] | None:
    """RSA-PSS headers matching loader/src/kalshi.ts buildKalshiAuthHeaders."""
    load_repo_env()
    key_id = (os.environ.get("KALSHI_ACCESS_KEY_ID") or "").strip()
    pem = _pem_text()
    if not key_id or not pem:
        return None
    timestamp = str(now_ms if now_ms is not None else int(time.time() * 1000))
    message = f"{timestamp}{method.upper()}{sign_path(url)}"
    key = serialization.load_pem_private_key(pem.encode("utf-8"), password=None)
    signature = key.sign(
        message.encode("utf-8"),
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32),
        hashes.SHA256(),
    )
    return {
        "KALSHI-ACCESS-KEY": key_id,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": base64.b64encode(signature).decode("ascii"),
    }


def ping(timeout_s: float = 20.0) -> dict[str, Any]:
    """Signed GET /exchange/status — status code only, no body dump."""
    result = get_json("/exchange/status", timeout_s=timeout_s, retries=2)
    return {
        "ok": bool(result.get("ok")),
        "status": result.get("status"),
        "signed": auth_configured(),
        "error": result.get("error"),
    }


def _map_market(raw: Any, *, category: str | None = None, market_type: str | None = None) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    ticker = str(raw.get("ticker") or "").strip().upper()
    if not ticker:
        return None
    last = parse_kalshi_number(raw.get("last_price_dollars") or raw.get("last_price"))
    return {
        "series_ticker": str(raw.get("series_ticker") or "").strip().upper()
        or series_ticker_from_market_ticker(ticker),
        "market_ticker": ticker,
        "event_ticker": str(raw.get("event_ticker") or "").strip().upper() or None,
        "title": str(raw.get("title") or ticker).strip(),
        "yes_subtitle": str(raw.get("yes_sub_title") or raw.get("subtitle") or "").strip() or None,
        "theme": "sports",
        "category": category,
        "status": str(raw.get("status") or "unknown").strip(),
        "market_type": market_type or str(raw.get("market_type") or "").strip() or None,
        "yes_bid": parse_kalshi_number(raw.get("yes_bid_dollars") or raw.get("yes_bid")),
        "yes_ask": parse_kalshi_number(raw.get("yes_ask_dollars") or raw.get("yes_ask")),
        "yes_last": last,
        "no_bid": parse_kalshi_number(raw.get("no_bid_dollars") or raw.get("no_bid")),
        "no_ask": parse_kalshi_number(raw.get("no_ask_dollars") or raw.get("no_ask")),
        "volume": parse_kalshi_number(raw.get("volume_fp") or raw.get("volume")),
        "liquidity": parse_kalshi_number(raw.get("liquidity_dollars") or raw.get("liquidity")),
        "close_time": str(raw.get("close_time") or "").strip() or None,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "source": "kalshi",
        "result": raw.get("result"),
    }


def fetch_open_mve_raw(max_pages: int = 5, page_limit: int = 200) -> tuple[list[Any], dict[str, Any]]:
    """GET /markets?mve_filter=only&status=open. No writes."""
    raw: list[Any] = []
    cursor = ""
    meta: dict[str, Any] = {"pages": 0, "ok": True, "error": None}
    for page in range(max(1, max_pages)):
        path = f"/markets?mve_filter=only&status=open&limit={page_limit}"
        if cursor:
            path += f"&cursor={quote(cursor)}"
        result = get_json(path)
        meta["pages"] = page + 1
        if not result.get("ok"):
            meta["ok"] = False
            meta["error"] = result.get("error")
            break
        markets = result["json"].get("markets")
        batch = markets if isinstance(markets, list) else []
        raw.extend(batch)
        cursor = str(result["json"].get("cursor") or "")
        if not cursor or not batch:
            break
    return raw, meta


def fetch_markets_by_tickers(tickers: list[str], chunk_size: int = 20) -> list[dict[str, Any]]:
    unique = list(dict.fromkeys(t.strip().upper() for t in tickers if t and t.strip()))
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i in range(0, len(unique), chunk_size):
        chunk = unique[i : i + chunk_size]
        path = f"/markets?tickers={quote(','.join(chunk))}&limit=200"
        result = get_json(path)
        if not result.get("ok"):
            continue
        markets = result["json"].get("markets")
        if not isinstance(markets, list):
            continue
        for raw in markets:
            mapped = _map_market(raw)
            if not mapped or mapped["market_ticker"] in seen:
                continue
            seen.add(mapped["market_ticker"])
            out.append(mapped)
    return out


def fetch_candlesticks(
    tickers: list[str],
    *,
    period_interval: int = 1,
    start_ts: int | None = None,
    end_ts: int | None = None,
) -> list[dict[str, Any]]:
    """Optional 1-minute candles. Cached locally — never written to Iceberg."""
    unique = list(dict.fromkeys(t.strip().upper() for t in tickers if t and t.strip()))
    if not unique:
        return []
    now = int(time.time())
    end_ts = end_ts or now
    start_ts = start_ts or (end_ts - 3600)
    out: list[dict[str, Any]] = []
    for i in range(0, len(unique), 20):
        batch = unique[i : i + 20]
        params = (
            f"market_tickers={','.join(batch)}"
            f"&start_ts={start_ts}&end_ts={end_ts}&period_interval={period_interval}"
        )
        result = get_json(f"/markets/candlesticks?{params}")
        markets = result.get("json", {}).get("markets") if result.get("ok") else None
        if not isinstance(markets, list):
            continue
        for item in markets:
            if not isinstance(item, dict):
                continue
            ticker = str(item.get("market_ticker") or "").strip().upper()
            candles = item.get("candlesticks")
            if not ticker or not isinstance(candles, list):
                continue
            for candle in candles:
                if not isinstance(candle, dict):
                    continue
                end_period = candle.get("end_period_ts")
                yes_bid = candle.get("yes_bid")
                yes_ask = candle.get("yes_ask")
                bid = parse_kalshi_number(
                    yes_bid.get("close_dollars") if isinstance(yes_bid, dict) else yes_bid
                )
                ask = parse_kalshi_number(
                    yes_ask.get("close_dollars") if isinstance(yes_ask, dict) else yes_ask
                )
                if bid is None and ask is None:
                    continue
                fetched = None
                if isinstance(end_period, (int, float)) and end_period > 0:
                    fetched = datetime.fromtimestamp(end_period, tz=timezone.utc).isoformat()
                out.append(
                    {
                        "market_ticker": ticker,
                        "yes_bid": bid,
                        "yes_ask": ask,
                        "end_period_ts": end_period,
                        "fetched_at": fetched,
                        "period_interval": period_interval,
                    }
                )
    return out


def pull_open_two_leg_sports(
    *,
    max_combos: int = 200,
    max_pages: int = 5,
) -> dict[str, Any]:
    """Open two-leg sports MVEs + selected legs. Signed GETs only. No RFQ."""
    raw, meta = fetch_open_mve_raw(max_pages=max_pages)
    investing: frozenset[str] = frozenset()
    combos: list[dict[str, Any]] = []
    leg_tickers: list[str] = []
    seen_legs: set[str] = set()
    crypto_skipped = 0
    scanned = 0
    for item in raw:
        scanned += 1
        if not is_sports_parlay_candidate(item, investing):
            legs_probe = parse_mve_selected_legs(item)
            if legs_probe and mve_tape_kind([leg.market_ticker for leg in legs_probe]) == "crypto_mve":
                crypto_skipped += 1
            continue
        legs = parse_mve_selected_legs(item)
        if len(legs) != 2:
            continue
        collection = mve_collection_ticker(item) or "UNKNOWN"
        mapped = _map_market(
            item,
            category=encode_mve_category(collection, legs),
            market_type="multivariate",
        )
        if not mapped:
            continue
        combos.append(mapped)
        for leg in legs:
            if leg.market_ticker in seen_legs:
                continue
            seen_legs.add(leg.market_ticker)
            leg_tickers.append(leg.market_ticker)
        if len(combos) >= max_combos:
            break
    legs = fetch_markets_by_tickers(leg_tickers)
    legs_by_ticker = {row["market_ticker"]: row for row in legs}
    return {
        "ok": meta.get("ok", False) or bool(combos),
        "error": meta.get("error"),
        "pages": meta.get("pages"),
        "scanned": scanned,
        "crypto_skipped": crypto_skipped,
        "combos": combos,
        "legs": legs,
        "legs_by_ticker": legs_by_ticker,
        "pulled_at": datetime.now(timezone.utc).isoformat(),
    }


LIVE_MARKETS_DDL = """
CREATE TABLE IF NOT EXISTS live_markets (
    pulled_at TIMESTAMP,
    role VARCHAR,
    market_ticker VARCHAR,
    event_ticker VARCHAR,
    title VARCHAR,
    category VARCHAR,
    status VARCHAR,
    market_type VARCHAR,
    yes_bid DOUBLE,
    yes_ask DOUBLE,
    yes_last DOUBLE,
    no_bid DOUBLE,
    volume DOUBLE,
    fetched_at VARCHAR,
    source VARCHAR
)
"""

LIVE_CANDLES_DDL = """
CREATE TABLE IF NOT EXISTS live_candles_1m (
    pulled_at TIMESTAMP,
    market_ticker VARCHAR,
    yes_bid DOUBLE,
    yes_ask DOUBLE,
    end_period_ts BIGINT,
    fetched_at VARCHAR,
    period_interval INTEGER
)
"""


def cache_live_tape(conn: Any, pack: dict[str, Any]) -> None:
    conn.execute(LIVE_MARKETS_DDL)
    conn.execute("DELETE FROM live_markets")
    pulled = pack.get("pulled_at") or datetime.now(timezone.utc).isoformat()
    rows = []
    for combo in pack.get("combos") or []:
        rows.append(_live_tuple(pulled, "combo", combo))
    for leg in pack.get("legs") or []:
        rows.append(_live_tuple(pulled, "leg", leg))
    if rows:
        conn.executemany(
            """
            INSERT INTO live_markets
            (pulled_at, role, market_ticker, event_ticker, title, category, status,
             market_type, yes_bid, yes_ask, yes_last, no_bid, volume, fetched_at, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )


def cache_live_candles(conn: Any, candles: list[dict[str, Any]]) -> None:
    conn.execute(LIVE_CANDLES_DDL)
    conn.execute("DELETE FROM live_candles_1m")
    pulled = datetime.now(timezone.utc)
    rows = [
        (
            pulled,
            c.get("market_ticker"),
            c.get("yes_bid"),
            c.get("yes_ask"),
            c.get("end_period_ts"),
            c.get("fetched_at"),
            c.get("period_interval") or 1,
        )
        for c in candles
    ]
    if rows:
        conn.executemany(
            """
            INSERT INTO live_candles_1m
            (pulled_at, market_ticker, yes_bid, yes_ask, end_period_ts, fetched_at, period_interval)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )


def _has_local_table(conn: Any, name: str) -> bool:
    try:
        row = conn.execute(
            """
            SELECT 1 FROM duckdb_tables()
            WHERE table_name = $name AND database_name != 'lake'
            LIMIT 1
            """,
            {"name": name},
        ).fetchone()
    except Exception:
        return False
    return row is not None


def load_cached_live_tape(conn: Any) -> dict[str, Any] | None:
    if not _has_local_table(conn, "live_markets"):
        return None
    rel = conn.execute("SELECT * FROM live_markets")
    cols = [d[0] for d in rel.description]
    combos: list[dict[str, Any]] = []
    legs: list[dict[str, Any]] = []
    pulled_at = None
    for row in rel.fetchall():
        rec = dict(zip(cols, row))
        pulled_at = rec.get("pulled_at") or pulled_at
        role = rec.get("role")
        rec.pop("role", None)
        rec.pop("pulled_at", None)
        if role == "combo":
            combos.append(rec)
        else:
            legs.append(rec)
    if not combos:
        return None
    return {
        "ok": True,
        "error": None,
        "cached": True,
        "combos": combos,
        "legs": legs,
        "legs_by_ticker": {row["market_ticker"]: row for row in legs},
        "pulled_at": str(pulled_at) if pulled_at else None,
        "crypto_skipped": 0,
        "scanned": len(combos),
        "pages": None,
    }


def load_cached_candles(conn: Any) -> dict[str, list[dict[str, Any]]]:
    if not _has_local_table(conn, "live_candles_1m"):
        return {}
    rel = conn.execute(
        "SELECT market_ticker, yes_bid, yes_ask, end_period_ts, fetched_at FROM live_candles_1m ORDER BY end_period_ts"
    )
    cols = [d[0] for d in rel.description]
    out: dict[str, list[dict[str, Any]]] = {}
    for row in rel.fetchall():
        rec = dict(zip(cols, row))
        ticker = str(rec.get("market_ticker") or "").upper()
        if not ticker:
            continue
        out.setdefault(ticker, []).append(rec)
    return out


def _live_tuple(pulled: Any, role: str, row: dict[str, Any]) -> tuple[Any, ...]:
    return (
        pulled,
        role,
        row.get("market_ticker"),
        row.get("event_ticker"),
        row.get("title"),
        row.get("category"),
        row.get("status"),
        row.get("market_type"),
        row.get("yes_bid"),
        row.get("yes_ask"),
        row.get("yes_last"),
        row.get("no_bid"),
        row.get("volume"),
        row.get("fetched_at"),
        row.get("source") or "kalshi",
    )
