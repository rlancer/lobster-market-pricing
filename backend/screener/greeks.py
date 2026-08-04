"""Recompute Black-Scholes option Greeks and backfill them into DuckDB.

Run with:

    cd backend && uv run python -m screener.greeks            # recompute all rows
    cd backend && uv run python -m screener.greeks --dry-run --limit 20
    mise run greeks -- --rate 0.043 --only NVDA

All Greeks are computed from the Black-Scholes (1973) model using data already
in the database (spot from ``underlyings``, strike / implied_vol / type /
expiration from ``option_contracts``). No external API calls are required; the
risk-free rate ``r`` defaults to a sensible constant (0.043) and is overridable
via ``--rate``. Dividend yield ``q`` is assumed to be zero (no dividend data in
the schema) — this is a documented limitation, noted in ``--help``.

Conventions are chosen to match what Yahoo Finance / the UI expect:
    * delta, gamma, vega, rho   — as-is from the formulas below
    * theta                      — per *calendar day*  (annual / 365)
    * vega                       — per 1.00 (100%) change in volatility
    * rho                        — per 1.00 (100%) change in rate
"""
from __future__ import annotations

import argparse
import datetime as _dt
import math
import sys
from typing import Iterable

from screener.db import connect

# Default risk-free rate. A plain constant is robust and avoids network calls;
    # override on the CLI with --rate. If you want a live rate, fetch ^IRX
    # (13-week T-bill) or ^TNX (10-year) via yfinance as a one-off and pass it
    # in with --rate; the code below never touches the network.
DEFAULT_RATE = 0.043


# --------------------------------------------------------------------------- #
# Black-Scholes math (pure stdlib, no numpy/scipy)
# --------------------------------------------------------------------------- #
_SQRT_2PI = math.sqrt(2.0 * math.pi)


def _norm_cdf(x: float) -> float:
    """Standard normal CDF via the Abramowitz-Stegun erf approximation."""
    # erf is in the math stdlib since 3.2; this is exact (no approximation).
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    """Standard normal PDF."""
    return math.exp(-0.5 * x * x) / _SQRT_2PI


def bs_greeks(
    S: float,
    K: float,
    T: float,
    sigma: float,
    r: float,
    is_call: bool,
) -> tuple[float, float, float, float, float]:
    """Return (delta, gamma, theta_per_day, vega, rho) for one option.

    Black-Scholes (zero dividends, q=0). ``T`` is in years. Caller must ensure
    S>0, K>0, T>0, sigma>0.
    """
    sqrtT = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    d2 = d1 - sigma * sqrtT

    pdf_d1 = _norm_pdf(d1)
    disc = math.exp(-r * T)

    gamma = pdf_d1 / (S * sigma * sqrtT)
    vega = S * pdf_d1 * sqrtT  # per 1.00 (100%) vol

    if is_call:
        delta = _norm_cdf(d1)
        # annual theta
        theta_annual = -(S * pdf_d1 * sigma) / (2.0 * sqrtT) - r * K * disc * _norm_cdf(d2)
        rho = K * T * disc * _norm_cdf(d2)  # per 1.00 (100%) rate
    else:
        delta = _norm_cdf(d1) - 1.0
        # annual theta (put-call parity: theta_put = theta_call + r*K*disc)
        theta_annual = -(S * pdf_d1 * sigma) / (2.0 * sqrtT) + r * K * disc * _norm_cdf(-d2)
        rho = -K * T * disc * _norm_cdf(-d2)  # per 1.00 (100%) rate

    theta = theta_annual / 365.0  # per calendar day
    return delta, gamma, theta, vega, rho


# --------------------------------------------------------------------------- #
# DB read
# --------------------------------------------------------------------------- #
def _fetch_rows(con, only: list[str] | None, null_only: bool, limit: int | None):
    """Yield rows needed to compute greeks, joined to underlyings for spot."""
    where_parts: list[str] = []
    params: list[object] = []

    if only:
        placeholders = ", ".join("?" for _ in only)
        where_parts.append(f"o.symbol IN ({placeholders})")
        params.extend(only)
    if null_only:
        where_parts.append("(o.delta IS NULL OR o.gamma IS NULL OR o.theta IS NULL OR o.vega IS NULL OR o.rho IS NULL)")

    where = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""
    sql_limit = f" LIMIT {int(limit)}" if limit else ""

    sql = f"""
        SELECT o.symbol, o.expiration, o.type, o.strike,
               o.implied_vol, u.spot
        FROM option_contracts o
        JOIN underlyings u ON u.symbol = o.symbol
        {where}
        {sql_limit}
    """
    return con.execute(sql, params).fetchall()


# --------------------------------------------------------------------------- #
# Compute + write
# --------------------------------------------------------------------------- #
def _classify_skip(expiration, sigma: float | None, S: float | None, K: float | None, today):
    """Return a skip reason string, or None if the row is computable."""
    if expiration is None:
        return "no_expiration"
    try:
        T = (expiration - today).days / 365.25
    except Exception:
        return "bad_expiration"
    if T <= 0:
        return "expired"
    if sigma is None or sigma <= 0 or not math.isfinite(sigma):
        return "bad_iv"
    if S is None or S <= 0 or not math.isfinite(S):
        return "bad_spot"
    if K is None or K <= 0 or not math.isfinite(K):
        return "bad_strike"
    return None


def _build_updates(rows, r: float, today):
    """Compute greeks for valid rows; return (updates, skip_counts)."""
    updates: list[tuple] = []
    skips: dict[str, int] = {}
    for row in rows:
        symbol, expiration, otype, strike, sigma, spot = row
        reason = _classify_skip(expiration, sigma, spot, strike, today)
        if reason is not None:
            skips[reason] = skips.get(reason, 0) + 1
            continue
        T = (expiration - today).days / 365.25
        try:
            delta, gamma, theta, vega, rho = bs_greeks(
                float(spot), float(strike), T, float(sigma), r, otype == "call"
            )
        except (ValueError, ZeroDivisionError, OverflowError):
            skips["math_error"] = skips.get("math_error", 0) + 1
            continue
        # sanity: replace non-finite with None so DuckDB stores NULL
        vals = []
        for v in (delta, gamma, theta, vega, rho):
            vals.append(v if (v is not None and math.isfinite(v)) else None)
        updates.append((vals[0], vals[1], vals[2], vals[3], vals[4],
                        symbol, expiration, otype, float(strike)))
    return updates, skips


def _write_updates(con, updates: list[tuple]) -> int:
    """UPDATE option_contracts SET greeks=... keyed on (symbol,exp,type,strike).

    Fast path: bulk-load the computed values into a temp table, then issue a
    single UPDATE ... FROM <join> against option_contracts. This is dramatically
    faster than 300k+ individual executemany UPDATEs (minutes -> seconds).
    """
    if not updates:
        return 0
    con.execute("DROP TABLE IF EXISTS _greek_updates")
    con.execute(
        """
        CREATE TEMP TABLE _greek_updates (
            delta DOUBLE, gamma DOUBLE, theta DOUBLE, vega DOUBLE, rho DOUBLE,
            symbol VARCHAR, expiration DATE, type VARCHAR, strike DOUBLE
        )
        """
    )
    # Batch the inserts for speed.
    batch = 50_000
    for i in range(0, len(updates), batch):
        con.executemany(
            "INSERT INTO _greek_updates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            updates[i:i + batch],
        )
    con.execute(
        """
        UPDATE option_contracts AS o
           SET delta  = g.delta,
               gamma  = g.gamma,
               theta  = g.theta,
               vega   = g.vega,
               rho    = g.rho
          FROM _greek_updates AS g
         WHERE o.symbol = g.symbol
           AND o.expiration = g.expiration
           AND o.type = g.type
           AND o.strike = g.strike
        """
    )
    con.execute("DROP TABLE _greek_updates")
    return len(updates)


# --------------------------------------------------------------------------- #
# Reporting helpers
# --------------------------------------------------------------------------- #
def _null_greek_counts(con) -> tuple[int, int]:
    total, null_delta = con.execute(
        "SELECT COUNT(*), SUM(CASE WHEN delta IS NULL THEN 1 ELSE 0 END) "
        "FROM option_contracts"
    ).fetchone()
    return int(total), int(null_delta or 0)


def _print_sample(rows, r: float, today, n: int = 20) -> None:
    print(f"\n--- sample (first {n} computable rows, r={r}) ---")
    header = ("symbol", "exp", "type", "strike", "IV", "S", "T", "delta", "gamma", "theta", "vega", "rho")
    print("{:<6} {:<12} {:<5} {:>8} {:>8} {:>9} {:>6} {:>8} {:>8} {:>9} {:>9} {:>8}".format(*header))
    printed = 0
    for row in rows:
        if printed >= n:
            break
        symbol, expiration, otype, strike, sigma, spot = row
        if _classify_skip(expiration, sigma, spot, strike, today) is not None:
            continue
        T = (expiration - today).days / 365.25
        d, g, th, v, rh = bs_greeks(float(spot), float(strike), T, float(sigma), r, otype == "call")
        print("{:<6} {:<12} {:<5} {:>8.2f} {:>8.4f} {:>9.2f} {:>6.3f} {:>8.4f} {:>8.6f} {:>9.4f} {:>9.4f} {:>8.4f}".format(
            str(symbol), str(expiration), str(otype), float(strike), float(sigma),
            float(spot), T, d, g, th, v, rh))
        printed += 1
    if printed == 0:
        print("(no computable rows in this slice)")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="screener.greeks",
        description=(
            "Recompute Black-Scholes Greeks (delta, gamma, theta, vega, rho) "
            "from spot/strike/IV/expiration already in DuckDB and write them "
            "back into option_contracts."
        ),
        epilog=(
            "Notes: risk-free rate r defaults to a constant (0.043); override "
            "with --rate. Dividend yield q is assumed 0 (no dividend data). "
            "theta is stored per calendar day; vega and rho are per 1.00 (100%) "
            "change in vol/rate respectively. Rows with T<=0 (expired) or "
            "missing/<=0 IV/spot/strike are skipped and left NULL."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--rate", type=float, default=DEFAULT_RATE,
                   help=f"Risk-free rate r (default {DEFAULT_RATE}).")
    p.add_argument("--only", nargs="+", metavar="SYMBOL",
                   help="Limit to these symbols (default: all).")
    p.add_argument("--null-only", action="store_true",
                   help="Only backfill rows where greeks are currently NULL.")
    p.add_argument("--dry-run", action="store_true",
                   help="Compute and print a sample (~20 rows) but do not write.")
    p.add_argument("--limit", type=int, default=None,
                   help="Process only N contracts (debug).")
    return p


def main(argv: Iterable[str] | None = None) -> int:
    args = _build_parser().parse_args(list(argv) if argv is not None else None)
    today = _dt.date.today()
    r = float(args.rate)

    con = connect(read_only=False)
    total_before, null_before = _null_greek_counts(con)

    rows = _fetch_rows(con, args.only, args.null_only, args.limit)
    rows = list(rows)
    rows_considered = len(rows)

    if args.dry_run:
        _print_sample(rows, r, today)
        # still report the skip breakdown over this slice
        _, skips = _build_updates(rows, r, today)
        print(f"\nrows considered : {rows_considered}")
        print(f"skipped         : {sum(skips.values())} {dict(skips) if skips else ''}")
        print(f"rate used       : r={r}")
        print("(dry-run: no writes performed)")
        return 0

    updates, skips = _build_updates(rows, r, today)
    n_updated = _write_updates(con, updates)

    total_after, null_after = _null_greek_counts(con)

    print("=" * 60)
    print("Black-Scholes Greek backfill complete")
    print("=" * 60)
    print(f"rate used            : r = {r}")
    print(f"rows considered      : {rows_considered}")
    print(f"rows skipped         : {sum(skips.values())}")
    for reason in ("expired", "bad_iv", "bad_spot", "bad_strike",
                   "no_expiration", "bad_expiration", "math_error"):
        if reason in skips:
            print(f"   {reason:<16}: {skips[reason]}")
    print(f"rows updated         : {n_updated}")
    print(f"NULL delta before    : {null_before} / {total_before}")
    print(f"NULL delta after     : {null_after} / {total_after}")
    print("=" * 60)
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
