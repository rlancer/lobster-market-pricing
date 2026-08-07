"""Small CBOE-to-Pipeline proof of concept.

The process intentionally holds one symbol response at a time. Durable output is
sent to configured pipeline endpoints; local stdout mode is only for a smoke run.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterable


PORT = int(os.environ.get("PORT", "8080"))
MAX_SYMBOLS = int(os.environ.get("MAX_SYMBOLS", "503"))
MAX_BATCH_RECORDS = int(os.environ.get("MAX_BATCH_RECORDS", "250"))
REQUEST_TIMEOUT = float(os.environ.get("REQUEST_TIMEOUT_SECONDS", "30"))
HTTP_RETRIES = int(os.environ.get("HTTP_RETRIES", "3"))
RETRY_BACKOFF_SECONDS = float(os.environ.get("RETRY_BACKOFF_SECONDS", "1"))
SYMBOL_DELAY_SECONDS = float(os.environ.get("SYMBOL_DELAY_SECONDS", "1"))
# Number of symbols fetched/normalized concurrently. The per-symbol work is
# I/O-bound (CBOE fetch + Pipeline POSTs), so threads overlap it near-linearly
# while the GIL is released during socket I/O — cutting the wall-clock of a full
# pass by ~Cx without extra container CPU on the hot path.
SYMBOL_CONCURRENCY = int(os.environ.get("SYMBOL_CONCURRENCY", "8"))
WRITE_MODE = os.environ.get("WRITE_MODE", "stdout").lower()
CBOE_URL = os.environ.get(
    "CBOE_URL_TEMPLATE",
    "https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json",
)
OCC_SYMBOL = re.compile(r"^[A-Z0-9.]{1,6}\d{6}[CP]\d{8}$")

CONSTITUENTS_PATH = os.environ.get("CONSTITUENTS_PATH", "")
_CONSTITUENTS_CACHE: dict[str, dict[str, str]] | None = None
_CONSTITUENTS_LOCK = threading.Lock()

CONTRACT_FIELDS = (
    "symbol", "expiration", "type", "strike", "last", "bid", "ask", "volume",
    "open_interest", "implied_vol", "delta", "gamma", "theta", "vega", "rho",
    "in_the_money", "theo", "bid_size", "ask_size", "run_id", "as_of_date",
    "fetched_at",
)

STATUS_LOCK = threading.Lock()
ACTIVE_STATUS: dict[str, Any] = {
    "status": "idle",
    "run_id": None,
    "expected_symbols": 0,
    "completed_symbols": 0,
    "successful_symbols": 0,
    "failed_symbols": 0,
    "current_symbol": None,
    "contract_count": 0,
    "current_contract_count": 0,
    "batch_number": 0,
    "last_event": None,
    "last_error": None,
}


def update_status(**updates: Any) -> None:
    with STATUS_LOCK:
        ACTIVE_STATUS.update(updates)


def status_snapshot() -> dict[str, Any]:
    with STATUS_LOCK:
        return dict(ACTIVE_STATUS)


def log_event(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), file=sys.stderr, flush=True)



def load_constituents() -> dict[str, dict[str, str]]:
    """Load the S&P 500 constituents map (symbol -> {name, sector}) used to
    enrich underlyings with company name and GICS sector. CBOE's delayed-quotes
    endpoint does not return a company name, so the name/sector are sourced from
    a static manifest committed alongside the loader (see symbols/
    sp500_constituents.json) and baked into the container image.

    The path is resolved in order: $CONSTITUENTS_PATH, /app/
    sp500_constituents.json (container), then a dev-relative fallback. Returns
    an empty map if no file is found so the loader still runs (name/sector
    fall back to the symbol / 'Unknown' downstream)."""
    global _CONSTITUENTS_CACHE
    with _CONSTITUENTS_LOCK:
        if _CONSTITUENTS_CACHE is not None:
            return _CONSTITUENTS_CACHE
        candidates = [CONSTITUENTS_PATH] if CONSTITUENTS_PATH else []
        candidates += [
            "/app/sp500_constituents.json",
            os.path.join(os.path.dirname(__file__), "sp500_constituents.json"),
            os.path.join(os.path.dirname(__file__), "..", "symbols", "sp500_constituents.json"),
        ]
        path = next((p for p in candidates if p and os.path.isfile(p)), "")
        result: dict[str, dict[str, str]] = {}
        if path:
            with open(path, "r", encoding="utf-8") as handle:
                doc = json.load(handle)
            for entry in doc.get("constituents", []):
                symbol = (entry.get("symbol") or "").strip().upper()
                if symbol:
                    result[symbol] = {"name": entry.get("name") or symbol, "sector": entry.get("sector") or "Unknown"}
            log_event("constituents_loaded", path=path, count=len(result))
        else:
            log_event("constituents_missing", reason="no sp500_constituents.json found; name/sector will fall back")
        _CONSTITUENTS_CACHE = result
        return result
SYMBOL_PATTERN = re.compile(r"^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$")


def normalize_symbols(symbols: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_symbol in symbols:
        symbol = raw_symbol.strip().upper()
        if not symbol or not SYMBOL_PATTERN.fullmatch(symbol) or len(symbol) > 6:
            raise ValueError(f"invalid symbol: {raw_symbol!r}")
        if symbol not in seen:
            seen.add(symbol)
            normalized.append(symbol)
    if not normalized:
        raise ValueError("symbols must contain at least one non-empty symbol")
    return normalized



def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def request_json(
    url: str,
    payload: Any,
    idempotency_key: str | None = None,
    auth_token: str | None = None,
) -> None:
    if WRITE_MODE == "stdout":
        print(json.dumps({"url": url, "payload": payload}, separators=(",", ":")), flush=True)
        return
    if WRITE_MODE != "pipeline":
        raise RuntimeError("WRITE_MODE must be stdout or pipeline")
    if not url:
        raise RuntimeError("pipeline output URL is not configured")
    if isinstance(payload, dict):
        payload = {key: value for key, value in payload.items() if value is not None}
    elif isinstance(payload, list):
        payload = [
            {key: value for key, value in record.items() if value is not None}
            if isinstance(record, dict) else record
            for record in payload
        ]
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {"content-type": "application/json", "user-agent": "cboe-to-r2/0.2"}
    token = auth_token or ""
    if idempotency_key and token:
        headers["idempotency-key"] = idempotency_key
    if token:
        headers["authorization"] = f"Bearer {token}"
    last_error: Exception | None = None
    for attempt in range(HTTP_RETRIES + 1):
        request = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                if 200 <= response.status < 300:
                    return
                if response.status < 500:
                    raise RuntimeError(f"pipeline returned HTTP {response.status}")
                last_error = RuntimeError(f"pipeline returned HTTP {response.status}")
        except urllib.error.HTTPError as error:
            detail = error.read(512).decode("utf-8", errors="replace")
            last_error = RuntimeError(f"pipeline returned HTTP {error.code}: {detail}")
            if error.code < 500:
                raise last_error from error
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
        if attempt < HTTP_RETRIES:
            time.sleep(RETRY_BACKOFF_SECONDS * (2**attempt))
    raise RuntimeError(f"pipeline request failed after {HTTP_RETRIES + 1} attempts: {last_error}") from last_error


def pipeline_url(name: str, output_urls: dict[str, str] | None = None) -> str:
    if output_urls and output_urls.get(name):
        return output_urls[name]
    return os.environ.get(name, "")


def post_batch(
    name: str,
    records: list[dict[str, Any]],
    output_urls: dict[str, str] | None = None,
    run_id: str | None = None,
    batch_number: int = 0,
    auth_token: str | None = None,
) -> None:
    if not records:
        return
    key = f"{run_id}:{name}:{batch_number}" if run_id else None
    request_json(pipeline_url(name, output_urls), records, key, auth_token)
    records.clear()


def first(mapping: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in mapping:
            return mapping[name]
    return None

def optional_float(value: Any) -> float | None:
    if value in (None, "", "-", "—", "N/A"):
        return None
    return float(value)


def optional_int(value: Any) -> int | None:
    number = optional_float(value)
    return None if number is None else int(number)


def optional_bool(value: Any) -> bool | None:
    if value in (None, "", "-", "—", "N/A"):
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ("true", "t", "yes", "1"):
            return True
        if normalized in ("false", "f", "no", "0"):
            return False
    raise ValueError(f"invalid boolean value: {value!r}")

def occ_fields(raw: dict[str, Any]) -> tuple[str | None, str | None, float | None]:
    option = first(raw, "option", "option_symbol", "symbol")
    if not isinstance(option, str) or not OCC_SYMBOL.fullmatch(option):
        raise ValueError("contract is missing a valid OCC option symbol")
    expiration = dt.date(
        2000 + int(option[-15:-13]), int(option[-13:-11]), int(option[-11:-9])
    ).isoformat()
    option_type = "call" if option[-9] == "C" else "put"
    strike = int(option[-8:]) / 1000
    return expiration, option_type, strike


def normalize_contract(raw: dict[str, Any], symbol: str, run_id: str, as_of_date: str, fetched_at: str) -> dict[str, Any]:
    occ_expiration, occ_type, occ_strike = occ_fields(raw)
    result = {
        "symbol": symbol,
        "expiration": first(raw, "expiration", "expirationDate", "expiry") or occ_expiration,
        "type": first(raw, "type", "option_type", "optionType") or occ_type,
        "strike": first(raw, "strike", "strikePrice") or occ_strike,
        "last": optional_float(first(raw, "last", "lastPrice", "last_trade_price")),
        "bid": optional_float(raw.get("bid")),
        "ask": optional_float(raw.get("ask")),
        "volume": optional_int(raw.get("volume")),
        "open_interest": optional_int(first(raw, "open_interest", "openInterest")),
        "implied_vol": optional_float(first(raw, "implied_vol", "impliedVolatility", "iv")),
        "delta": optional_float(raw.get("delta")),
        "gamma": optional_float(raw.get("gamma")),
        "theta": optional_float(raw.get("theta")),
        "vega": optional_float(raw.get("vega")),
        "rho": optional_float(raw.get("rho")),
        "in_the_money": optional_bool(first(raw, "in_the_money", "inTheMoney")),
        "theo": optional_float(first(raw, "theo", "theoretical")),
        "bid_size": optional_int(first(raw, "bid_size", "bidSize")),
        "ask_size": optional_int(first(raw, "ask_size", "askSize")),
        "run_id": run_id,
        "as_of_date": as_of_date,
        "fetched_at": fetched_at,
    }
    if not result["expiration"] or result["type"] not in ("call", "put") or result["strike"] is None:
        raise ValueError("contract has invalid normalized expiration, type, or strike")
    return {field: result[field] for field in CONTRACT_FIELDS}


def fetch_chain(symbol: str) -> dict[str, Any]:
    url = CBOE_URL.format(symbol=urllib.parse.quote(symbol, safe=""))
    last_error: Exception | None = None
    for attempt in range(HTTP_RETRIES + 1):
        request = urllib.request.Request(url, headers={"user-agent": "cboe-to-r2/0.2"})
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code not in (408, 429) and error.code < 500:
                raise
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
        if attempt < HTTP_RETRIES:
            retry_after = float(last_error.headers.get("retry-after", "0")) if isinstance(last_error, urllib.error.HTTPError) else 0
            time.sleep(max(RETRY_BACKOFF_SECONDS * (2**attempt), retry_after))
    raise RuntimeError(f"CBOE request failed after {HTTP_RETRIES + 1} attempts: {last_error}") from last_error


def chain_records(payload: dict[str, Any]) -> tuple[Iterable[dict[str, Any]], dict[str, Any]]:
    raw = payload.get("data", payload)
    if isinstance(raw, list):
        return raw, payload
    if not isinstance(raw, dict):
        raise ValueError("CBOE response data is not an object or list")
    contracts = raw.get("options", raw.get("contracts", []))
    if not isinstance(contracts, list):
        raise ValueError("CBOE response has no options array")
    return contracts, raw


def run_load(
    symbols: list[str],
    output_urls: dict[str, str] | None = None,
    pipeline_auth_token: str | None = None,
) -> dict[str, Any]:
    symbols = normalize_symbols(symbols)
    if len(symbols) > MAX_SYMBOLS:
        raise ValueError(f"symbol limit is {MAX_SYMBOLS} symbols per request")
    run_id = str(uuid.uuid4())
    started_at = utc_now()
    as_of_date = started_at[:10]
    update_status(
        status="running", run_id=run_id, expected_symbols=len(symbols),
        completed_symbols=0, successful_symbols=0, failed_symbols=0,
        current_symbol=None, contract_count=0, current_contract_count=0,
        batch_number=0, last_event="run_started", last_error=None,
    )
    log_event("run_started", run_id=run_id, expected_symbols=len(symbols))

    run_url = pipeline_url("PIPELINE_RUNS_URL", output_urls)
    underlying_url = pipeline_url("PIPELINE_UNDERLYINGS_URL", output_urls)
    contract_url_name = "PIPELINE_CONTRACTS_URL"
    error_url_name = "PIPELINE_ERRORS_URL"
    run = {
        "run_id": run_id,
        "started_at": started_at,
        "completed_at": None,
        "as_of_date": as_of_date,
        "expected_symbols": len(symbols),
        "successful_symbols": 0,
        "failed_symbols": 0,
        "contract_count": 0,
        "status": "running",
        "error_summary": None,
    }
    request_json(run_url, run, f"{run_id}:run:running", pipeline_auth_token)

    # Per-symbol workers run concurrently. All shared mutable state lives in
    # `state` and is only touched under `state_lock`; the only I/O done under the
    # lock is the bounded buffer append (pipeline POSTs happen outside it).
    state = {
        "pending": [],            # normalized contract records awaiting a full-batch flush
        "batch_number": 0,
        "successful_symbols": 0,
        "contract_count": 0,
    }
    failures: list[dict[str, str]] = []
    error_records: list[dict[str, str]] = []
    state_lock = threading.Lock()

    def enqueue_contracts(records):
        """Publish `records`; flush complete MAX_BATCH_RECORDS chunks out of the lock."""
        if not records:
            return
        with state_lock:
            state["pending"].extend(records)
        while True:
            with state_lock:
                if len(state["pending"]) < MAX_BATCH_RECORDS:
                    return
                chunk = state["pending"][:MAX_BATCH_RECORDS]
                del state["pending"][:MAX_BATCH_RECORDS]
                state["batch_number"] += 1
                batch_number = state["batch_number"]
            log_event("contract_batch_sending", run_id=run_id, batch_number=batch_number, records=len(chunk))
            post_batch(contract_url_name, chunk, output_urls, run_id, batch_number, pipeline_auth_token)

    def process_symbol(symbol):
        fetched_at = utc_now()
        log_event("symbol_started", run_id=run_id, symbol=symbol)
        try:
            payload = fetch_chain(symbol)
            raw_contracts, metadata = chain_records(payload)
            constituents = load_constituents()
            meta = constituents.get(symbol, {})
            underlying = {
                "symbol": symbol,
                "name": meta.get("name") or symbol,
                "sector": meta.get("sector") or "Unknown",
                "spot_price": optional_float(first(metadata, "current_price", "spot_price", "price")),
                "description": first(metadata, "description", "company_name"),
                "run_id": run_id,
                "as_of_date": as_of_date,
                "fetched_at": fetched_at,
            }
            # Normalize the whole chain into a local list first: if the symbol
            # ultimately fails, its partial records are simply discarded (nothing
            # ever touched shared state), preserving the serial "a failed symbol
            # publishes nothing" guarantee.
            symbol_records: list[dict[str, Any]] = []
            for raw in raw_contracts:
                if not isinstance(raw, dict):
                    raise ValueError("contract entry is not an object")
                symbol_records.append(normalize_contract(raw, symbol, run_id, as_of_date, fetched_at))
            if not symbol_records:
                raise ValueError("CBOE chain contained no contracts")
            enqueue_contracts(symbol_records)
            request_json(underlying_url, [underlying], f"{run_id}:underlying:{symbol}", pipeline_auth_token)
            with state_lock:
                state["successful_symbols"] += 1
                state["contract_count"] += len(symbol_records)
                completed = state["successful_symbols"] + len(failures)
            log_event("symbol_completed", run_id=run_id, symbol=symbol, contracts=len(symbol_records), completed_symbols=completed)
        except Exception as error:  # one symbol must not abort the bounded refresh
            error_text = str(error)
            with state_lock:
                failures.append({"symbol": symbol, "error": error_text})
                error_records.append({
                    "run_id": run_id, "symbol": symbol, "status": "unavailable",
                    "error": error_text, "failed_at": utc_now(),
                })
                completed = state["successful_symbols"] + len(failures)
            log_event("symbol_failed", run_id=run_id, symbol=symbol, error=error_text)
        finally:
            if SYMBOL_DELAY_SECONDS:
                time.sleep(SYMBOL_DELAY_SECONDS)

    with ThreadPoolExecutor(max_workers=SYMBOL_CONCURRENCY) as executor:
        futures = [executor.submit(process_symbol, symbol) for symbol in symbols]
        for future in futures:
            future.result()  # process_symbol catches Exception; this surfaces BaseException only

    # Flush any trailing partial buffer (< MAX_BATCH_RECORDS) from the last worker.
    with state_lock:
        tail = state["pending"]
        state["pending"] = []
    if tail:
        with state_lock:
            state["batch_number"] += 1
            batch_number = state["batch_number"]
        post_batch(contract_url_name, tail, output_urls, run_id, batch_number, pipeline_auth_token)

    run["successful_symbols"] = state["successful_symbols"]
    run["contract_count"] = state["contract_count"]

    run["failed_symbols"] = len(failures)
    run["completed_at"] = utc_now()
    run["error_summary"] = json.dumps(failures, separators=(",", ":")) if failures else None
    run["status"] = "complete" if not failures else "failed"
    update_status(
        status=run["status"], completed_symbols=len(symbols),
        successful_symbols=run["successful_symbols"], failed_symbols=run["failed_symbols"],
        current_symbol=None, contract_count=run["contract_count"], current_contract_count=0,
        last_event="run_completed", last_error=failures[-1]["error"] if failures else None,
    )
    error_url = pipeline_url(error_url_name, output_urls)
    if error_records and error_url:
        request_json(error_url, error_records, f"{run_id}:errors", pipeline_auth_token)
    request_json(run_url, run, f"{run_id}:run:final", pipeline_auth_token)
    return {"run": run, "failures": failures}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            json_response(self, 200, {"ok": True, "write_mode": WRITE_MODE, "max_symbols": MAX_SYMBOLS})
            return
        if self.path == "/status":
            json_response(self, 200, {"ok": True, "loader": status_snapshot()})
            return
        json_response(self, 404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/run":
            json_response(self, 404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            request = json.loads(self.rfile.read(length))
            symbols = request.get("symbols") if isinstance(request, dict) else None
            if not isinstance(symbols, list) or not all(isinstance(s, str) for s in symbols):
                raise ValueError("body must be {\"symbols\":[\"AAPL\"]}")
            output_urls = {
                "PIPELINE_RUNS_URL": self.headers.get("x-pipeline-runs-url", ""),
                "PIPELINE_CONTRACTS_URL": self.headers.get("x-pipeline-contracts-url", ""),
                "PIPELINE_UNDERLYINGS_URL": self.headers.get("x-pipeline-underlyings-url", ""),
                "PIPELINE_ERRORS_URL": self.headers.get("x-pipeline-errors-url", ""),
            }
            pipeline_auth_token = self.headers.get("x-pipeline-auth-token", "")
            result = run_load(
                normalize_symbols(symbols),
                output_urls,
                pipeline_auth_token,
            )
            json_response(self, 200 if result["run"]["status"] == "complete" else 502, result)
        except Exception as error:
            json_response(self, 400, {"error": str(error)})

    def log_message(self, format: str, *args: Any) -> None:
        print(format % args, file=sys.stderr, flush=True)


if __name__ == "__main__":
    print(f"CBOE loader listening on :{PORT} (mode={WRITE_MODE})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
