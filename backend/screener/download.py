"""Download S&P 500 option chains via yfinance and store them in DuckDB.

Features:
  * Resumable: re-running without --fresh skips symbols already completed
    (tracked in download_log with status='ok'). Per-symbol writes are
    idempotent (DELETE then INSERT per symbol), so a crashed run can be
    safely restarted.
  * Retry with exponential backoff on Yahoo 429 / transient errors.
  * Chunked spot-price fetch to avoid giant single batch downloads.
  * Throttled with adaptive sleep.
"""
from __future__ import annotations

import argparse
import math
import os
import time
import uuid
from datetime import datetime, timezone

import pandas as pd
import yfinance as yf

from .db import connect, init_schema, reset
from .sp500 import fetch_sp500

# Persist a run_id across resumes by storing it in a file in the data dir.
RUN_ID_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", ".run_id"
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _safe_float(v):
    try:
        if v is None:
            return None
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except Exception:
        return None


def _safe_int(v):
    try:
        if v is None:
            return None
        return int(v)
    except Exception:
        return None


def _get_run_id(fresh: bool) -> str:
    os.makedirs(os.path.dirname(RUN_ID_FILE), exist_ok=True)
    if fresh:
        rid = str(uuid.uuid4())[:8]
        with open(RUN_ID_FILE, "w") as f:
            f.write(rid)
        return rid
    try:
        with open(RUN_ID_FILE) as f:
            return f.read().strip()
    except FileNotFoundError:
        rid = str(uuid.uuid4())[:8]
        with open(RUN_ID_FILE, "w") as f:
            f.write(rid)
        return rid


def fetch_underlyings(symbols: list[str], chunk_size: int = 50) -> dict[str, float]:
    """Fetch spot prices in chunks via yfinance batch download."""
    closes: dict[str, float] = {}
    for i in range(0, len(symbols), chunk_size):
        batch = symbols[i:i + chunk_size]
        for attempt in range(3):
            try:
                data = yf.download(batch, period="1d", interval="1d",
                                   progress=False, threads=True, group_by="column")
                break
            except Exception as e:
                print(f"  underlying chunk {i} attempt {attempt+1} failed: {e}")
                time.sleep(2 ** attempt)
        else:
            continue
        if data is None or data.empty:
            continue
        try:
            if len(batch) == 1:
                closes[batch[0]] = _safe_float(data["Close"].iloc[-1])
            else:
                close_df = data["Close"]
                for sym in close_df.columns:
                    try:
                        v = close_df[sym].iloc[-1]
                        if pd.notna(v):
                            closes[sym] = _safe_float(v)
                    except Exception:
                        pass
        except Exception as e:
            print(f"  underlying chunk {i} parse error: {e}")
        time.sleep(0.3)
    return closes


def _download_chain_once(symbol: str, max_expirations: int | None) -> tuple[list[dict], int, int]:
    t = yf.Ticker(symbol)
    expirations = t.options or ()
    if max_expirations is not None:
        expirations = list(expirations)[:max_expirations]

    rows: list[dict] = []
    for exp in expirations:
        chain = t.option_chain(exp)
        for opt_type, df in (("call", chain.calls), ("put", chain.puts)):
            if df is None or df.empty:
                continue
            for _, r in df.iterrows():
                rows.append({
                    "symbol": symbol,
                    "expiration": str(exp),
                    "type": opt_type,
                    "strike": _safe_float(r.get("strike")),
                    "last": _safe_float(r.get("lastPrice")),
                    "bid": _safe_float(r.get("bid")),
                    "ask": _safe_float(r.get("ask")),
                    "volume": _safe_int(r.get("volume")),
                    "open_interest": _safe_int(r.get("openInterest")),
                    "implied_vol": _safe_float(r.get("impliedVolatility")),
                    "delta": _safe_float(r.get("delta")),
                    "gamma": _safe_float(r.get("gamma")),
                    "theta": _safe_float(r.get("theta")),
                    "vega": _safe_float(r.get("vega")),
                    "rho": _safe_float(r.get("rho")),
                    "in_the_money": bool(r.get("inTheMoney", False)),
                })
    return rows, len(expirations), len(rows)


def download_chain(symbol: str, max_expirations: int | None = None,
                   max_retries: int = 3) -> tuple[list[dict], int, int]:
    """Download option chains for one symbol with retry/backoff."""
    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            return _download_chain_once(symbol, max_expirations)
        except Exception as e:
            last_err = e
            msg = str(e).lower()
            # 429 Too Many Requests -> longer backoff
            sleep = (4 ** attempt) if "429" in msg else (2 ** attempt)
            print(f"    {symbol} attempt {attempt+1}/{max_retries} failed: {e} — sleep {sleep}s")
            time.sleep(sleep)
    raise last_err  # type: ignore[misc]


def _already_done(con, run_id: str, symbol: str) -> bool:
    r = con.execute(
        "SELECT 1 FROM download_log WHERE run_id=? AND symbol=? AND status='ok' LIMIT 1",
        [run_id, symbol],
    ).fetchone()
    return r is not None


def _store_symbol(con, run_id: str, symbol: str, rows: list[dict],
                  n_exp: int, n_con: int, started: datetime) -> None:
    """Idempotent per-symbol write: delete existing contracts then insert."""
    con.execute("DELETE FROM option_contracts WHERE symbol = ?", [symbol])
    if rows:
        con.executemany(
            """INSERT INTO option_contracts VALUES
               (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [(r["symbol"], r["expiration"], r["type"], r["strike"], r["last"],
              r["bid"], r["ask"], r["volume"], r["open_interest"], r["implied_vol"],
              r["delta"], r["gamma"], r["theta"], r["vega"], r["rho"],
              r["in_the_money"], _now()) for r in rows],
        )
    con.execute(
        "INSERT INTO download_log VALUES (?, ?, ?, ?, 'ok', NULL, ?, ?)",
        [run_id, symbol, n_exp, n_con, started, _now()],
    )


def _store_error(con, run_id: str, symbol: str, err: str, started: datetime) -> None:
    con.execute(
        "INSERT INTO download_log VALUES (?, ?, 0, 0, 'error', ?, ?, ?)",
        [run_id, symbol, err[:300], started, _now()],
    )


def run(limit: int | None = None, max_expirations: int | None = None,
        fresh: bool = False, only: list[str] | None = None,
        sleep: float = 0.2) -> None:
    run_id = _get_run_id(fresh)
    con = connect()
    init_schema(con)
    if fresh:
        reset(con)
        # reset clears download_log too, so nothing is "already done"

    constituents = fetch_sp500()
    if only:
        wanted = [s.upper() for s in only]
        constituents = constituents[constituents["symbol"].str.upper().isin(wanted)]
    if limit:
        constituents = constituents.head(limit)

    symbols = constituents["symbol"].tolist()
    print(f"[{run_id}] {'FRESH' if fresh else 'RESUME'} run for {len(symbols)} symbols.")

    # Underlyings: refresh always (cheap, and we want fresh spot prices).
    print(f"[{run_id}] Fetching spot prices for {len(symbols)} underlyings...")
    prices = fetch_underlyings(symbols)
    print(f"[{run_id}] Got spot prices for {len(prices)}/{len(symbols)} symbols.")

    # Upsert underlyings (delete + insert all — cheap).
    con.execute("DELETE FROM underlyings")
    under_rows = []
    for _, r in constituents.iterrows():
        sym = r["symbol"]
        under_rows.append((sym, r["name"], r["sector"], prices.get(sym), _now()))
    con.executemany("INSERT INTO underlyings VALUES (?, ?, ?, ?, ?)", under_rows)

    # Resume: figure out what's left
    done = {s for (s,) in con.execute(
        "SELECT symbol FROM download_log WHERE run_id=? AND status='ok'", [run_id]
    ).fetchall()}
    todo = [s for s in symbols if s not in done]
    skipped = len(symbols) - len(todo)
    print(f"[{run_id}] Resume: skipping {skipped} already-done symbols, {len(todo)} to go.")

    total_new = 0
    errors = 0
    for i, sym in enumerate(todo, 1):
        started = _now()
        try:
            rows, n_exp, n_con = download_chain(sym, max_expirations=max_expirations)
            _store_symbol(con, run_id, sym, rows, n_exp, n_con, started)
            total_new += n_con
            print(f"[{i}/{len(todo)}] {sym}: {n_exp} exp, {n_con} contracts "
                  f"(run total new={total_new})")
        except Exception as e:
            _store_error(con, run_id, sym, str(e), started)
            errors += 1
            print(f"[{i}/{len(todo)}] {sym}: ERROR {e}")
        # commit happens implicitly per execute in DuckDB; flush by reconnect-free checkpoint
        time.sleep(sleep)

    # Final summary
    total_contracts = con.execute("SELECT COUNT(*) FROM option_contracts").fetchone()[0]
    total_under = con.execute("SELECT COUNT(*) FROM underlyings").fetchone()[0]
    n_ok = con.execute(
        "SELECT COUNT(*) FROM download_log WHERE run_id=? AND status='ok'", [run_id]
    ).fetchone()[0]
    n_err = con.execute(
        "SELECT COUNT(*) FROM download_log WHERE run_id=? AND status='error'", [run_id]
    ).fetchone()[0]
    print(f"\n[{run_id}] DONE. underlyings={total_under} contracts={total_contracts} "
          f"(new this session={total_new}) ok={n_ok} errors={n_err}")
    if n_err:
        print(f"[{run_id}] Failed symbols (re-run to retry):")
        for (s, err) in con.execute(
            "SELECT symbol, error FROM download_log WHERE run_id=? AND status='error'",
            [run_id],
        ).fetchall():
            print(f"   {s}: {err}")


def main() -> None:
    p = argparse.ArgumentParser(description="Download S&P 500 option chains into DuckDB.")
    p.add_argument("--limit", type=int, default=None, help="Only download first N symbols (debug).")
    p.add_argument("--max-expirations", type=int, default=None,
                   help="Cap number of expiration dates per symbol.")
    p.add_argument("--fresh", action="store_true",
                   help="Drop existing data and start a new run (clears resume state).")
    p.add_argument("--only", nargs="*", default=None, help="Only these symbols.")
    p.add_argument("--sleep", type=float, default=0.2,
                   help="Sleep between symbols (seconds). Default 0.2.")
    args = p.parse_args()
    run(limit=args.limit, max_expirations=args.max_expirations,
        fresh=args.fresh, only=args.only, sleep=args.sleep)


if __name__ == "__main__":
    main()
