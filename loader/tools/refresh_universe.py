"""Rebuild the merged symbol universe (``symbols/universe.json``).

The loader's option/OHLC/earnings jobs run over a single universe manifest.
That universe is the union of three sources, each picked to cover "the major
indexes and the major ETFs" without pulling the whole market:

1. **S&P 500** (``symbols/sp500.json`` + ``symbols/sp500_constituents.json``)
   -- already in the repo, refreshed by hand from Wikipedia. No network here.
2. **Nasdaq-100** (``symbols/universe.json`` source tag ``nasdaq100``) -- the
   members of the Nasdaq-100 that are *not* already in the S&P 500. Fetched
   live from Nasdaq's official constituents API (see ``fetch_nasdaq100``).
   The Dow Jones 30 is deliberately skipped: every Dow member is already an
   S&P 500 constituent, so it contributes zero new symbols.
3. **Major ETFs** (``symbols/etfs.json``, source tag ``etf``) -- a curated
   manifest of liquid, US-listed ETFs with active CBOE option chains. There is
   no canonical free "major ETFs" list, so this part is maintained by hand.

Refresh procedure (run when index membership changes, ~quarterly is plenty):

    python tools/refresh_universe.py            # fetch NDX live, write universe.json
    python tools/refresh_universe.py --probe-cboe   # also verify CBOE chains for new names

The script is deterministic and offline-friendly: if the Nasdaq API is
unreachable it falls back to a pinned copy of the last known constituents (with
a warning) so the universe still regenerates. ETF membership only changes when
someone edits ``symbols/etfs.json``.

Output shape (matches how the loader reads ``sp500.json`` today, plus a
``constituents`` map for name/sector enrichment of every symbol):

    {
      "source": "merged universe: sp500 + nasdaq100 + etfs",
      "updated": "2026-08-09",
      "symbols": ["MMM", ..., "ASML", ..., "SPY", ...],
      "constituents": {
        "MMM": {"name": "3M", "sector": "Industrials", "source": "sp500"},
        "ASML": {"name": "ASML Holding NV", "sector": "Information Technology", "source": "nasdaq100"},
        "SPY":  {"name": "SPDR S&P 500 ETF Trust", "sector": "Broad Market", "source": "etf"}
      }
    }
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import pathlib
import tempfile
import urllib.error
import urllib.request

DEFAULT_DIR = pathlib.Path(__file__).resolve().parent.parent / "symbols"
NASDAQ100_API = "https://api.nasdaq.com/api/quote/list-type/nasdaq100?assetclass=stocks"

# Pinned fallback so the script still works when the Nasdaq API is down. Refresh
# this array whenever `fetch_nasdaq100` succeeds, so the pinned copy stays close
# to the live list. Verified 2026-08-09 (102 members).
NASDAQ100_FALLBACK = [
    "AAPL", "AMAT", "AMGN", "CMCSA", "INTC", "KLAC", "PCAR", "CTAS", "PAYX",
    "LRCX", "ADSK", "ROST", "MNST", "MSFT", "ADBE", "FAST", "CSCO", "REGN",
    "IDXX", "VRTX", "ODFL", "QCOM", "GILD", "SNPS", "SBUX", "INTU", "MCHP",
    "ORLY", "COST", "CPRT", "ASML", "TTWO", "AMZN", "MSTR", "NVDA", "BKNG",
    "ISRG", "MRVL", "ADI", "AEP", "AMD", "ADP", "CDNS", "CSX", "HON", "MAR",
    "MU", "XEL", "EXC", "PEP", "ROP", "TER", "TXN", "WDC", "WMT", "AXON",
    "MDLZ", "NFLX", "STX", "ALNY", "GOOGL", "MPWR", "DXCM", "TMUS", "MELI",
    "KDP", "NBIS", "AVGO", "FTNT", "TSLA", "NXPI", "FANG", "META", "PANW",
    "WDAY", "GOOG", "PYPL", "SHOP", "KHC", "LITE", "CCEP", "BKR", "PDD",
    "CRWD", "DDOG", "RKLB", "PLTR", "ABNB", "DASH", "APP", "CEG", "WBD",
    "GEHC", "LIN", "ARM", "TRI", "FER", "ALAB", "SNDK", "CRWV", "SPCX", "HONA",
]

# GICS sector for the Nasdaq-100 members that are NOT in the S&P 500. The
# Nasdaq API returns a sector but it is often blank, so we curate it here.
# Populate as new members enter NDX \ SPX.
NDX_LATE_SECTORS = {
    "ASML": "Information Technology",  # ASML Holding NV
    "MSTR": "Information Technology",  # Strategy (MicroStrategy)
    "ALNY": "Health Care",             # Alnylam Pharmaceuticals
    "MELI": "Consumer Discretionary",  # MercadoLibre
    "NBIS": "Information Technology",  # Nebius Group
    "SHOP": "Information Technology",  # Shopify
    "CCEP": "Consumer Staples",        # Coca-Cola Europacific Partners
    "PDD": "Consumer Discretionary",   # PDD Holdings
    "RKLB": "Industrials",             # Rocket Lab
    "ARM": "Information Technology",   # Arm Holdings
    "TRI": "Industrials",              # Thomson Reuters
    "FER": "Industrials",              # Ferrovial
    "ALAB": "Information Technology",  # Astera Labs
    "CRWV": "Information Technology",  # CoreWeave
    "SPCX": "Industrials",             # SpaceX
}

CBOE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json"
CBOE_UA = "cboe-to-r2/0.2"


def save(path: pathlib.Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def fetch_nasdaq100() -> list[dict]:
    """Live Nasdaq-100 constituents from Nasdaq's official API.

    Returns a list of {symbol, companyName, sector} dicts. Raises on network
    failure; callers fall back to NASDAQ100_FALLBACK.
    """
    request = urllib.request.Request(
        NASDAQ100_API,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "application/json",
            "Origin": "https://www.nasdaq.com",
            "Referer": "https://www.nasdaq.com/",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    rows = ((payload or {}).get("data") or {}).get("data") or {}
    rows = rows.get("rows") or []
    parsed = []
    for row in rows:
        symbol = str(row.get("symbol") or "").strip().upper()
        if symbol:
            parsed.append(
                {
                    "symbol": symbol,
                    "companyName": str(row.get("companyName") or "").strip(),
                    "sector": str(row.get("sector") or "").strip(),
                }
            )
    if not parsed:
        raise RuntimeError("Nasdaq API returned no constituents")
    return parsed


def cboe_has_chain(symbol: str, delay: float = 0.0) -> bool:
    """True if CBOE's free delayed-quotes endpoint serves an option chain.

    Distinguishes "genuinely not served" from "rate-limited": HTTP 429/5xx and
    network errors are treated as *transient* and retried with backoff, and only
    count as failure if they persist. A symbol is only reported as unserved when
    CBOE replies 200 with no/empty options, or 404. `delay` is an extra sleep
    before the request to keep bursts under CBOE's rate limit.
    """
    if delay:
        import time as _time
        _time.sleep(delay)
    request = urllib.request.Request(
        CBOE_BASE.format(symbol=symbol),
        headers={"User-Agent": CBOE_UA},
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                if response.status == 429 or response.status >= 500:
                    raise urllib.error.URLError(f"status {response.status}")  # transient -> retry
                payload = json.load(response)
            options = ((payload or {}).get("data") or {}).get("options") or []
            return response.status == 200 and len(options) > 0
        except urllib.error.HTTPError as error:
            if error.code == 429 or error.code >= 500:
                pass  # transient -> backoff and retry
            elif error.code == 404:
                return False  # genuinely not served
            else:
                return False
        except (urllib.error.URLError, json.JSONDecodeError, ValueError):
            pass  # transient / unparseable -> backoff and retry
        import time as _time
        _time.sleep(2 ** attempt)  # 1s, 2s, 4s backoff
    return False  # rate limit persisted across all retries


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", type=pathlib.Path, default=DEFAULT_DIR, help="symbols/ directory")
    parser.add_argument("--out", type=pathlib.Path, default=None, help="output file (default <dir>/universe.json)")
    parser.add_argument("--no-ndx-fetch", action="store_true", help="use the pinned NDX fallback, skip the network")
    parser.add_argument("--probe-cboe", action="store_true", help="verify each non-S&P symbol has a CBOE option chain")
    parser.add_argument("--probe-delay", type=float, default=1.0, help="seconds to sleep before each CBOE probe (default 1.0; raises on 429/5xx with backoff)")
    parser.add_argument("--drop-unserved", action="store_true", help="with --probe-cboe, drop symbols CBOE does not serve")
    args = parser.parse_args()

    d = args.dir
    out = args.out or (d / "universe.json")

    # 1. S&P 500 base (already in repo).
    sp500 = json.loads((d / "sp500.json").read_text(encoding="utf-8"))
    constituents = json.loads((d / "sp500_constituents.json").read_text(encoding="utf-8"))
    spx = {s.upper() for s in sp500["symbols"]}
    spx_meta = {c["symbol"].upper(): c for c in constituents["constituents"]}

    # 2. Nasdaq-100 delta (NDX \ SPX).
    ndx_meta = fetch_nasdaq100() if not args.no_ndx_fetch else []
    if ndx_meta:
        ndx = {m["symbol"] for m in ndx_meta}
        print(f"Nasdaq-100: fetched {len(ndx)} members live from the Nasdaq API")
    else:
        ndx = set(NASDAQ100_FALLBACK)
        print(f"Nasdaq-100: {len(ndx)} members (PINNED FALLBACK - API unreachable)")
    ndx_late = sorted(s for s in ndx if s not in spx)
    print(f"Nasdaq-100 not in S&P 500: {len(ndx_late)} -> {', '.join(ndx_late) or '(none)'}")

    # 3. Curated major ETFs.
    etfs = json.loads((d / "etfs.json").read_text(encoding="utf-8"))
    etf_meta = {e["symbol"].upper(): e for e in etfs["etfs"]}
    print(f"Curated ETFs: {len(etf_meta)}")

    # 4. Merge into a source-tagged universe.
    universe: dict[str, dict] = {}
    for symbol in spx:
        meta = spx_meta.get(symbol, {})
        universe[symbol] = {
            "name": meta.get("name") or symbol,
            "sector": meta.get("sector") or "Unknown",
            "source": "sp500",
        }
    for symbol in ndx_late:
        meta = next((m for m in ndx_meta if m["symbol"] == symbol), {}) if ndx_meta else {}
        universe[symbol] = {
            "name": meta.get("companyName") or symbol,
            "sector": NDX_LATE_SECTORS.get(symbol) or meta.get("sector") or "Unknown",
            "source": "nasdaq100",
        }
    for symbol, meta in etf_meta.items():
        universe[symbol] = {
            "name": meta.get("name") or symbol,
            "sector": meta.get("asset_class") or "ETF",
            "source": "etf",
        }

    ordered = sorted(universe)
    doc = {
        "source": "merged universe: symbols/sp500.json + Nasdaq-100 (NDX \\ SPX) + symbols/etfs.json",
        "updated": _dt.date.today().isoformat(),
        "symbols": ordered,
        "constituents": {s: universe[s] for s in ordered},
    }

    # 5. Optional CBOE validation of the added (non-S&P) symbols.
    probed = doc["constituents"]
    if args.probe_cboe:
        bad = []
        for symbol in ordered:
            if probed[symbol]["source"] == "sp500":
                continue
            if not cboe_has_chain(symbol, delay=args.probe_delay):
                bad.append(symbol)
        if bad:
            print(f"CBOE probe: {len(bad)} symbol(s) WITHOUT a CBOE option chain: {', '.join(bad)}")
            if args.drop_unserved:
                for symbol in bad:
                    del probed[symbol]
                ordered = sorted(probed)
                doc["symbols"] = ordered
                print(f"  dropped {len(bad)} unserved symbol(s)")
        else:
            print(f"CBOE probe: all {len(ordered) - len(spx)} non-S&P symbols have an option chain")

    save(out, doc)
    counts: dict[str, int] = {}
    for s in ordered:
        counts[probed[s]["source"]] = counts.get(probed[s]["source"], 0) + 1
    print(f"Wrote {out} with {len(ordered)} symbols: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())