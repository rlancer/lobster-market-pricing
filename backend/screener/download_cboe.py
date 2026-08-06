"""Download S&P 500 option chains from CBOE delayed quotes into DuckDB.

This is the **hard cutover** replacement for `download.py` (yfinance). CBOE's
delayed-quotes API returns every expiration and all Greeks in a *single* HTTP
call per symbol, so there is no per-expiration loop, no separate spot fetch,
and no Black-Scholes backfill (`greeks.py`) — the whole Yahoo pipeline is gone.

  URL:  https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json
  One call per symbol. Payload envelope:
    { timestamp, symbol, data: { symbol, security_type, current_price, bid,
      ask, open, high, low, close, prev_day_close, volume, iv30,
      ..., options: [ { option, bid, bid_size, ask, ask_size, iv,
      open_interest, volume, delta, gamma, theta, vega, rho, theo,
      last_trade_price, last_trade_time, ... } ] } }

  Field scale (verified live at implementation, Aug 2026):
    * `iv` is already an ANNUALIZED DECIMAL fraction (0.3396 = 33.96%) for
      normal near-ATM rows — copy it straight into `implied_vol`. The `iv`
      values like `3.564` on deep-ITM, nearly-expired rows are aberrant
      day-1/illiquid artifacts and are copied verbatim like Yahoo's oddities
      were; there is no `*100` / `/100` normalization.
    * `delta/gamma/theta/vega/rho` arrive in Black-Scholes units — copy as-is.
    * `theo` (theoretical price), `bid_size`, `ask_size` are new persisted
      columns.
    * The `option` string is OCC-standard ROOT + YYMMDD + C/P + strike
      (5 or 8 digits). The strike is price * 1000 for the 8-digit form
      (e.g. `00205000` -> 205.000), price * 100 for the legacy 5-digit form.
    * Dotted symbols (BRK.B) are passed straight to the API and kept dotted
      in the DB. CBOE returns the dotted symbol in `data.symbol`, but the OCC
      *roots* drop the dot (BRK.B -> `BRKB`), so we key `option_contracts`
      on the requested symbol (dotted) to keep the `underlyings` join working.

  THE FETCH LAYER (`parse_occ` / `normalize_option` / `fetch_symbol` /
  `fetch_all`) IS DELIBERATELY ISOLATED: no DuckDB, no Parquet, no pandas.
  Only the `run()`/CLI driver touches the database. This keeps a later port to
  a Cloudflare Worker (TS) a near-mechanical translation of
  `fetch_symbol` only.
"""
from __future__ import annotations

import argparse
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import requests

from .db import connect, init_schema, reset
from .sp500 import fetch_sp500

CBOE_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json"
HEADERS = {
    "Accept": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
}

# 404 / other 4xx means the symbol has no chain — don't waste retries on it.
class CboeSymbolError(RuntimeError):
    """Raised when CBOE responds 4xx (non-429) for a symbol (no retry)."""


class CboeRetryableError(RuntimeError):
    """Raised for transient failures (429 throttling, 5xx, timeouts) — retry with backoff."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_float(v: Any) -> float | None:
    try:
        if v is None:
            return None
        f = float(v)
        if f != f or f in (float("inf"), float("-inf")):  # NaN / inf
            return None
        return f
    except (TypeError, ValueError):
        return None


def _safe_int(v: Any) -> int | None:
    try:
        if v is None:
            return None
        return int(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Isolated fetch layer (portable to a Cloudflare Worker; no DB coupling).
# ---------------------------------------------------------------------------
def parse_occ(option: str) -> tuple[str, str, str, float]:
    """Parse an OCC option symbol into (root, expiration, type, strike).

    OCC layout: ROOT + YYMMDD + C/P + strike. The strike is the trailing
    5 or 8 digits: 8-digit = price * 1000 (e.g. `00205000` -> 205.000),
    5-digit = price * 100 (legacy). Returned expiration is 'YYYY-MM-DD'.
    """
    i = 0
    while i < len(option) and option[i].isalpha():
        i += 1
    root = option[:i]
    rest = option[i:]
    ymd, cp, strike_str = rest[:6], rest[6], rest[7:]
    year = 2000 + int(ymd[0:2])
    month = int(ymd[2:4])
    day = int(ymd[4:6])
    expiration = f"{year:04d}-{month:02d}-{day:02d}"
    opt_type = "call" if cp == "C" else "put"
    strike = (
        int(strike_str) / 1000.0 if len(strike_str) == 8 else int(strike_str) / 100.0
    )
    return root, expiration, opt_type, strike


def normalize_option(o: dict, symbol: str, spot: float | None) -> dict | None:
    """Map one CBOE `options[]` record to the `option_contracts` row shape."""
    option = o.get("option")
    if not option:
        return None
    try:
        root, expiration, opt_type, strike = parse_occ(option)
    except Exception:
        return None

    bid = _safe_float(o.get("bid"))
    ask = _safe_float(o.get("ask"))
    last = _safe_float(o.get("last_trade_price"))

    # in_the_money: call moneyness is strike < spot; put is strike > spot.
    itm: bool | None = None
    if spot is not None:
        itm = strike < spot if opt_type == "call" else strike > spot

    return {
        "symbol": symbol,          # requested symbol (dotted preserved) — matches underlyings
        "expiration": expiration,
        "type": opt_type,
        "strike": strike,
        "last": last,
        "bid": bid,
        "ask": ask,
        "volume": _safe_int(o.get("volume")),
        "open_interest": _safe_int(o.get("open_interest")),
        "implied_vol": _safe_float(o.get("iv")),
        "delta": _safe_float(o.get("delta")),
        "gamma": _safe_float(o.get("gamma")),
        "theta": _safe_float(o.get("theta")),
        "vega": _safe_float(o.get("vega")),
        "rho": _safe_float(o.get("rho")),
        "in_the_money": itm,
        "theo": _safe_float(o.get("theo")),
        "bid_size": _safe_int(o.get("bid_size")),
        "ask_size": _safe_int(o.get("ask_size")),
    }


def fetch_symbol(symbol: str, timeout: int = 30) -> dict:
    """Fetch one symbol's full chain from CBOE and normalize it.

    Returns:
        {"symbol", "spot", "expirations", "rows": [ {..row..}, ... ]}
    """
    sym = symbol.strip().upper()
    resp = requests.get(CBOE_URL.format(symbol=sym), headers=HEADERS, timeout=timeout)
    if resp.status_code == 429 or resp.status_code >= 500:
        # 429 = rate-limited, 5xx = upstream hiccup: retriable with backoff.
        raise CboeRetryableError(f"HTTP {resp.status_code} for {sym}")
    if resp.status_code != 200:
        # 404 unknown symbol, 400, 403, ... -> permanent, no retry.
        raise CboeSymbolError(f"HTTP {resp.status_code} for {sym}")
    payload = resp.json()
    data = payload.get("data") or {}
    spot = _safe_float(data.get("current_price"))
    # CBOE returns the canonical symbol (e.g. BRK.B) in the envelope, but the
    # OCC roots are dot-less (BRKB). We always join on the requested symbol.
    rows: list[dict] = []
    expirations: set[str] = set()
    for o in data.get("options") or []:
        row = normalize_option(o, sym, spot)
        if row is None:
            continue
        rows.append(row)
        expirations.add(row["expiration"])
    return {
        "symbol": sym,
        "spot": spot,
        "expirations": len(expirations),
        "rows": rows,
    }


def fetch_all(
    symbols: list[str],
    sleep: float = 0.25,
    max_retries: int = 3,
    timeout: int = 30,
    quiet: bool = False,
) -> list[dict]:
    """Fetch every symbol with retry/backoff on transient (5xx) errors.

    Returns a list of result dicts:
        {"symbol", "ok": True,  "spot", "expirations", "rows"}
        {"symbol", "ok": False, "error"}
    """
    results: list[dict] = []
    for i, sym in enumerate(symbols, 1):
        res: dict = {"symbol": sym}
        last_err: Exception | None = None
        ok = False
        for attempt in range(max_retries):
            try:
                data = fetch_symbol(sym, timeout=timeout)
                res.update(data)
                res["ok"] = True
                ok = True
                break
            except CboeSymbolError as e:
                # Permanent (404/other 4xx). Fail fast for this symbol.
                last_err = e
                break
            except CboeRetryableError as e:
                # Transient (429/5xx): back off, then retry. 429 throttling is
                # the common case on a full run, so give it a longer wait.
                last_err = e
                if "429" in str(e):
                    time.sleep((2 ** attempt) * 5.0)   # 5s, 10s, 20s
                else:
                    time.sleep((2 ** attempt) * sleep)
            except Exception as e:  # network-level failures
                last_err = e
                time.sleep((2 ** attempt) * sleep)
        if not ok:
            res["ok"] = False
            res["error"] = str(last_err)
        results.append(res)
        n_rows = len(res.get("rows", [])) if ok else 0
        if not quiet:
            status = f"{n_rows} contracts" if ok else f"ERROR {res['error']}"
            print(f"[{i}/{len(symbols)}] {sym}: {status}")
        time.sleep(sleep)
    return results


# ---------------------------------------------------------------------------
# DuckDB driver (the only DB-coupled part).
# ---------------------------------------------------------------------------
def _store_symbol(con, run_id: str, symbol: str, rows: list[dict],
                  n_exp: int, started: datetime) -> None:
    """Idempotent per-symbol write: delete existing contracts then insert."""
    con.execute("DELETE FROM option_contracts WHERE symbol = ?", [symbol])
    if rows:
        con.executemany(
            """INSERT INTO option_contracts VALUES
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [(r["symbol"], r["expiration"], r["type"], r["strike"], r["last"],
              r["bid"], r["ask"], r["volume"], r["open_interest"],
              r["implied_vol"], r["delta"], r["gamma"], r["theta"], r["vega"],
              r["rho"], r["in_the_money"], r["theo"], r["bid_size"],
              r["ask_size"], _now()) for r in rows],
        )
    con.execute(
        "INSERT INTO download_log VALUES (?, ?, ?, ?, 'ok', NULL, ?, ?)",
        [run_id, symbol, n_exp, len(rows), started, _now()],
    )


def _store_error(con, run_id: str, symbol: str, err: str, started: datetime) -> None:
    con.execute(
        "INSERT INTO download_log VALUES (?, ?, 0, 0, 'error', ?, ?, ?)",
        [run_id, symbol, (err or "")[:300], started, _now()],
    )


def run(limit: int | None = None, only: list[str] | None = None,
        sleep: float = 0.5, timeout: int = 30, quiet: bool = False) -> int:
    """Full-refresh download: reset schema, fetch all symbols, write DuckDB.

    This is a hard cutover -> a full re-pull each run (no resume/backfill).
    A fresh `run_id` is minted per invocation and each symbol's failure is
    recorded in `download_log`.

    Returns the number of failed symbols (0 = success). The caller (CI / CLI)
    must treat any non-zero as a failure so partial data is never uploaded.
    """
    run_id = str(uuid.uuid4())[:8]
    con = connect()
    init_schema(con)
    reset(con)  # drop + recreate everything: this is a full snapshot

    constituents = fetch_sp500()  # list[dict]: symbol, name, sector (dotted)
    if only:
        wanted = {s.upper() for s in only}
        constituents = [c for c in constituents if c["symbol"].upper() in wanted]
    if limit:
        constituents = constituents[:limit]

    symbols = [c["symbol"] for c in constituents]
    print(f"[{run_id}] CBOE full refresh for {len(symbols)} symbols (sleep={sleep}s).")
    started = _now()
    results = fetch_all(symbols, sleep=sleep, timeout=timeout, quiet=quiet)

    # underlyings: replace all rows; spot comes from the same CBOE call.
    spot_by_symbol = {r["symbol"]: r.get("spot") for r in results if r["ok"]}
    con.execute("DELETE FROM underlyings")
    con.executemany(
        "INSERT INTO underlyings VALUES (?, ?, ?, ?, ?)",
        [(c["symbol"], c["name"], c["sector"], spot_by_symbol.get(c["symbol"]), _now())
         for c in constituents],
    )

    errors = 0
    for res in results:
        if not res["ok"]:
            _store_error(con, run_id, res["symbol"], res.get("error", ""), started)
            errors += 1
            continue
        _store_symbol(con, run_id, res["symbol"], res["rows"], res["expirations"], started)

    total_contracts = con.execute("SELECT COUNT(*) FROM option_contracts").fetchone()[0]
    total_under = con.execute("SELECT COUNT(*) FROM underlyings").fetchone()[0]
    print(f"\n[{run_id}] DONE. underlyings={total_under} contracts={total_contracts} "
          f"errors={errors}")
    if errors:
        print(f"[{run_id}] Failed symbols (re-run to retry):")
        for (s, err) in con.execute(
            "SELECT symbol, error FROM download_log WHERE run_id=? AND status='error'",
            [run_id],
        ).fetchall():
            print(f"   {s}: {err}")
    return errors


def main() -> None:
    p = argparse.ArgumentParser(
        description="Download S&P 500 option chains from CBOE into DuckDB."
    )
    p.add_argument("--limit", type=int, default=None,
                   help="Only download first N symbols (debug).")
    p.add_argument("--only", nargs="*", default=None, help="Only these symbols.")
    p.add_argument("--sleep", type=float, default=0.5,
                   help="Sleep between symbols (seconds). Default 0.5 (CBOE throttles faster runs).")
    p.add_argument("--timeout", type=int, default=30, help="HTTP timeout (sec).")
    p.add_argument("--quiet", action="store_true", help="Only print the summary.")
    args = p.parse_args()
    errors = run(limit=args.limit, only=args.only, sleep=args.sleep,
                 timeout=args.timeout, quiet=args.quiet)
    if errors:
        # Non-zero exit so CI stops before exporting/uploading partial data.
        raise SystemExit(f"{errors} symbol(s) failed to download")


if __name__ == "__main__":
    main()
