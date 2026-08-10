// CBOE fetch + normalize + Pipeline-publish path as a pure TS module (ported
// from the retired container/loader.py, now running in-process). runSymbols is
// the single loader entrypoint — called in-process by the CboeContinuousLoader
// DO's tick() and by the public POST /run handler. The container is gone.
//
// Invariant: per-symbol output records, idempotency keys, retry/backoff and
// header shape match the original loader behavior. Publication order is
// deterministic in symbol-input order regardless of SYMBOL_CONCURRENCY (see
// runSymbols) so a C=1 and C=8 pass of the same symbol set produce identical
// pipeline output.
//
// This module is pure — it only depends on global fetch / crypto, so it is
// directly testable.

import constituentsData from "../symbols/sp500_constituents.json";
import { securityIdForTicker } from "./symbology.js";

export const DEFAULT_CBOE_URL_TEMPLATE =
  "https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json";

const OCC_SYMBOL = /^[A-Z0-9.]{1,6}\d{6}[CP]\d{8}$/;
const SYMBOL_PATTERN = /^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/;

export const MAX_SYMBOLS_DEFAULT = 503;
export const MAX_BATCH_RECORDS_DEFAULT = 250;
export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const SYMBOL_CONCURRENCY_DEFAULT = 8;
export const SYMBOL_DELAY_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 30;

export const CONTRACT_FIELDS = [
  "symbol", "expiration", "type", "strike", "last", "bid", "ask", "volume",
  "open_interest", "implied_vol", "delta", "gamma", "theta", "vega", "rho",
  "in_the_money", "theo", "bid_size", "ask_size", "run_id", "as_of_date",
  "fetched_at",
] as const;

// A normalized contract record: keys exactly CONTRACT_FIELDS order, values are
// the scalars the loader publishes (the same POST-time null-stripping as
// loader.py applies). Represented as Record<string, unknown> because CBOE raw
// values of unknown/provided shape flow through before serialization.

// Env shape consumed by runSymbols. PIPELINE_* match the pipeline_url() names
// in loader.py (secret-backed URLs come from the Worker env at runtime). The
// now/runId hooks are optional test seams — the production DO omits them.
export interface LoaderEnv {
  CBOE_URL_TEMPLATE?: string;
  PIPELINE_RUNS_URL?: string;
  PIPELINE_CONTRACTS_URL?: string;
  PIPELINE_UNDERLYING_SNAPSHOTS_URL?: string;
  PIPELINE_ERRORS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  MAX_SYMBOLS?: number;
  MAX_BATCH_RECORDS?: number;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  SYMBOL_CONCURRENCY?: number;
  SYMBOL_DELAY_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  // Test seams (optional).
  now?: () => Date;
  runId?: () => string;
}

export interface RunFailure {
  symbol: string;
  error: string;
}

export interface RunResult {
  run: Record<string, unknown>;
  failures: RunFailure[];
}

// Load the S&P 500 constituents map (symbol -> {name, sector}) used to enrich
// underlyings with company name / GICS sector. Mirrors load_constituents() in
// loader.py: name/sector fall back to the symbol / "Unknown", and a symbol
// missing from the manifest still publishes an underlying.
const CONSTITUENTS = new Map<string, { name: string; sector: string }>();
{
  const doc: unknown = constituentsData;
  if (doc && typeof doc === "object" && "constituents" in doc) {
    const entries = (doc as { constituents: unknown }).constituents;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const rec = entry as Record<string, unknown>;
        const symbol = String(rec.symbol ?? "").trim().toUpperCase();
        if (symbol) {
          CONSTITUENTS.set(symbol, {
            name: String(rec.name ?? "") || symbol,
            sector: String(rec.sector ?? "") || "Unknown",
          });
        }
      }
    }
  }
}

function num(v: number | undefined, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function backoffSeconds(env: LoaderEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

// Narrow a parsed-JSON value that is known to be a plain object into a map.
// Returns null when it isn't one (it still has to flow through this guard).
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Symbol normalization
// ---------------------------------------------------------------------------
export function normalizeSymbols(symbols: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of symbols) {
    const symbol = String(raw ?? "").trim().toUpperCase();
    if (!symbol || !SYMBOL_PATTERN.test(symbol) || symbol.length > 6) {
      throw new Error(`invalid symbol: ${JSON.stringify(raw)}`);
    }
    if (!seen.has(symbol)) {
      seen.add(symbol);
      normalized.push(symbol);
    }
  }
  if (normalized.length === 0) {
    throw new Error("symbols must contain at least one non-empty symbol");
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// OCC / value helpers (mirror occ_fields / optional_* in loader.py)
// ---------------------------------------------------------------------------
export interface OccFields {
  expiration: string;
  optionType: "call" | "put";
  strike: number;
}

export function occFields(raw: Record<string, unknown>): OccFields {
  const option = first(raw, "option", "option_symbol", "symbol");
  if (typeof option !== "string" || !OCC_SYMBOL.test(option)) {
    throw new Error("contract is missing a valid OCC option symbol");
  }
  const year = 2000 + Number(option.slice(-15, -13));
  const month = option.slice(-13, -11);
  const day = option.slice(-11, -9);
  const expiration = `${year}-${month}-${day}`;
  const optionType = option.slice(-9, -8) === "C" ? "call" : "put";
  const strike = Number(option.slice(-8)) / 1000;
  return { expiration, optionType, strike };
}

// Note: contract/underlying records come straight from parsed external JSON
// (values are `unknown` until narrowed). `first` mirrors the loader's
// first-named-field lookup; callers narrow with guards or `||` fallbacks.
function first(mapping: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (name in mapping) return mapping[name];
  }
  return undefined;
}

// Python `first(mapping, ...) or fallback`: the raw value wins when truthy,
// otherwise the fallback. The result stays `unknown`; consumers narrow/validate.
function orElse(value: unknown, fallback: unknown): unknown {
  return value || fallback;
}

function optionalFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === "-" || value === "—" || value === "N/A") {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`invalid numeric value: ${JSON.stringify(value)}`);
  }
  return n;
}

function optionalInt(value: unknown): number | null {
  const f = optionalFloat(value);
  return f === null ? null : Math.trunc(f);
}

function optionalBool(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "" || value === "-" || value === "—" || value === "N/A") {
    return null;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "t", "yes", "1"].includes(normalized)) return true;
    if (["false", "f", "no", "0"].includes(normalized)) return false;
  }
  throw new Error(`invalid boolean value: ${JSON.stringify(value)}`);
}

export function normalizeContract(
  raw: Record<string, unknown>,
  symbol: string,
  runId: string,
  asOfDate: string,
  fetchedAt: string,
): Record<string, unknown> {
  const { expiration: occExpiration, optionType: occType, strike: occStrike } = occFields(raw);
  const result: Record<string, unknown> = {
    symbol,
    expiration: orElse(first(raw, "expiration", "expirationDate", "expiry"), occExpiration),
    type: orElse(first(raw, "type", "option_type", "optionType"), occType),
    strike: orElse(first(raw, "strike", "strikePrice"), occStrike),
    last: optionalFloat(first(raw, "last", "lastPrice", "last_trade_price")),
    bid: optionalFloat(raw.bid),
    ask: optionalFloat(raw.ask),
    volume: optionalInt(raw.volume),
    open_interest: optionalInt(first(raw, "open_interest", "openInterest")),
    implied_vol: optionalFloat(first(raw, "implied_vol", "impliedVolatility", "iv")),
    delta: optionalFloat(raw.delta),
    gamma: optionalFloat(raw.gamma),
    theta: optionalFloat(raw.theta),
    vega: optionalFloat(raw.vega),
    rho: optionalFloat(raw.rho),
    in_the_money: optionalBool(first(raw, "in_the_money", "inTheMoney")),
    theo: optionalFloat(first(raw, "theo", "theoretical")),
    bid_size: optionalInt(first(raw, "bid_size", "bidSize")),
    ask_size: optionalInt(first(raw, "ask_size", "askSize")),
    run_id: runId,
    as_of_date: asOfDate,
    fetched_at: fetchedAt,
  };
  if (
    !result.expiration ||
    (result.type !== "call" && result.type !== "put") ||
    result.strike === null ||
    result.strike === undefined
  ) {
    throw new Error("contract has invalid normalized expiration, type, or strike");
  }
  const out: Record<string, unknown> = {};
  for (const field of CONTRACT_FIELDS) {
    out[field] = result[field];
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function stripNones(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNones);
  const rec = asRecord(value);
  if (rec) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      const v = rec[key];
      if (v !== null && v !== undefined) out[key] = v;
    }
    return out;
  }
  return value;
}

// POST a payload to a Pipeline endpoint with the loader User-Agent and retry /
// backoff parity with request_json() in loader.py: retry only on 5xx and
// network errors; 4xx is a hard failure. Idempotency-key is only sent when both
// a key and an auth token are present (as in Python).
async function requestJson(
  url: string,
  payload: unknown,
  idempotencyKey: string | null,
  authToken: string,
  env: LoaderEnv,
): Promise<void> {
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const body = JSON.stringify(stripNones(payload));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "cboe-to-r2/0.2",
  };
  if (idempotencyKey && authToken) headers["idempotency-key"] = idempotencyKey;
  if (authToken) headers["authorization"] = `Bearer ${authToken}`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body });
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(backoffSeconds(env, attempt) * 1000);
        continue;
      }
      break;
    }
    if (response.ok) return;
    const code = response.status;
    const detail = await response.text();
    lastError = new Error(`pipeline returned HTTP ${code}: ${detail}`);
    if (code < 500) throw lastError; // non-retryable 4xx
    if (attempt < retries) {
      await sleep(backoffSeconds(env, attempt) * 1000);
    }
  }
  throw new Error(`pipeline request failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

// GET a CBOE delayed-quotes chain with retry-after / backoff parity with
// fetch_chain() in loader.py: retry on 408, 429, 5xx and network errors only.
async function fetchChain(symbol: string, env: LoaderEnv): Promise<unknown> {
  const template = env.CBOE_URL_TEMPLATE || DEFAULT_CBOE_URL_TEMPLATE;
  const url = template.replace("{symbol}", encodeURIComponent(symbol));
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { headers: { "user-agent": "cboe-to-r2/0.2" } });
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(backoffSeconds(env, attempt) * 1000);
        continue;
      }
      break;
    }
    if (response.ok) return await response.json();
    const code = response.status;
    lastError = new Error(`CBOE returned HTTP ${code}`);
    if (code !== 408 && code !== 429 && code < 500) throw lastError;
    if (attempt < retries) {
      const retryAfter = Number(response.headers.get("retry-after") || "0");
      const delay = Math.max(backoffSeconds(env, attempt), Number.isFinite(retryAfter) ? retryAfter : 0);
      await sleep(delay * 1000);
    }
  }
  throw new Error(`CBOE request failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

function chainRecords(
  payload: unknown,
): { contracts: Array<Record<string, unknown>>; metadata: Record<string, unknown> } {
  const payloadRec = asRecord(payload);
  const raw = payloadRec && "data" in payloadRec ? payloadRec.data : payload;
  if (Array.isArray(raw)) {
    return { contracts: raw, metadata: payloadRec ?? {} };
  }
  const obj = asRecord(raw);
  if (!obj) {
    throw new Error("CBOE response data is not an object or list");
  }
  let list: unknown;
  if ("options" in obj) list = obj.options;
  else if ("contracts" in obj) list = obj.contracts;
  else list = [];
  if (!Array.isArray(list)) {
    throw new Error("CBOE response has no options array");
  }
  return { contracts: list, metadata: obj };
}

// A small promise semaphore (mirrors the Python ThreadPoolExecutor at
// SYMBOL_CONCURRENCY without any thread/GIL artifact).
function semaphore(limit: number): { acquire(): Promise<void>; release(): void } {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active < limit && queue.length > 0) {
      active++;
      const resume = queue.shift();
      if (resume) resume();
    }
  };
  return {
    acquire() {
      const { promise, resolve } = Promise.withResolvers<void>();
      queue.push(resolve);
      next();
      return promise;
    },
    release() {
      active--;
      next();
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Shape an underlying_snapshots record (options.underlying_snapshots) from the
// underlyings record. It keeps the run-history half (spot + run/fetched timing)
// plus the denormalized ticker/name/sector, keyed by the stable security_id.
function underlyingSnapshot(
  symbol: string,
  underlying: Record<string, unknown>,
): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    security_id: securityIdForTicker(symbol),
    ticker: underlying.symbol ?? symbol,
    spot_price: underlying.spot_price ?? null,
    name: underlying.name ?? null,
    sector: underlying.sector ?? null,
    run_id: underlying.run_id,
    as_of_date: underlying.as_of_date,
    fetched_at: underlying.fetched_at,
  };
  const out: Record<string, unknown> = {};
  const SNAPSHOT_FIELDS = [
    "security_id", "ticker", "spot_price", "name", "sector",
    "run_id", "as_of_date", "fetched_at",
  ] as const;
  for (const f of SNAPSHOT_FIELDS) out[f] = rec[f];
  return out;
}

export async function runSymbols(symbols: string[], env: LoaderEnv = {}): Promise<RunResult> {
  const normalized = normalizeSymbols(symbols);
  const maxSymbols = Math.floor(num(env.MAX_SYMBOLS, MAX_SYMBOLS_DEFAULT));
  if (normalized.length > maxSymbols) {
    throw new Error(`symbol limit is ${maxSymbols} symbols per request`);
  }

  const runId = env.runId ? env.runId() : crypto.randomUUID();
  const clock = () => (env.now ? env.now() : new Date());
  const startedAt = clock().toISOString();
  const asOfDate = startedAt.slice(0, 10);

  const runUrl = env.PIPELINE_RUNS_URL || "";
  const snapshotUrl = env.PIPELINE_UNDERLYING_SNAPSHOTS_URL || "";
  const contractsUrl = env.PIPELINE_CONTRACTS_URL || "";
  const errorUrl = env.PIPELINE_ERRORS_URL || "";
  const authToken = env.PIPELINE_AUTH_TOKEN || "";
  const maxBatch = Math.max(1, Math.floor(num(env.MAX_BATCH_RECORDS, MAX_BATCH_RECORDS_DEFAULT)));
  const concurrency = Math.max(1, Math.floor(num(env.SYMBOL_CONCURRENCY, SYMBOL_CONCURRENCY_DEFAULT)));
  const delayMs = Math.floor(num(env.SYMBOL_DELAY_SECONDS, SYMBOL_DELAY_SECONDS_DEFAULT) * 1000);

  const run: Record<string, unknown> = {
    run_id: runId,
    started_at: startedAt,
    completed_at: null,
    as_of_date: asOfDate,
    expected_symbols: normalized.length,
    successful_symbols: 0,
    failed_symbols: 0,
    contract_count: 0,
    status: "running",
    error_summary: null,
  };
  await requestJson(runUrl, run, `${runId}:run:running`, authToken, env);

  // Per-symbol outcomes in input-index order. undefined = pending, null =
  // failed (no records), otherwise {records, underlying}.
  const results: Array<{ records: Array<Record<string, unknown>>; underlying: Record<string, unknown> } | null | undefined> =
    new Array(normalized.length).fill(undefined);

  const failures: RunFailure[] = [];
  const errorRecords: Array<Record<string, unknown>> = [];
  const pending: Array<Record<string, unknown>> = [];
  let batchNumber = 0;
  let nextToPublish = 0;
  let successfulSymbols = 0;
  let contractCount = 0;

  async function postContracts(chunk: Array<Record<string, unknown>>, number: number): Promise<void> {
    await requestJson(contractsUrl, chunk, `${runId}:PIPELINE_CONTRACTS_URL:${number}`, authToken, env);
  }

  // Publish the longest fully-completed prefix of symbols in input order,
  // flushing MAX_BATCH_RECORDS contract chunks as they fill. Because the whole
  // prefix is drained in index order regardless of completion order, the
  // published stream is deterministic for any concurrency > 0.
  // Publish is serialized through a promise chain (a lightweight mutex) so the
  // shared {nextToPublish, pending, batchNumber} state is only ever mutated by
  // one coroutine at a time, even though symbols complete concurrently. This is
  // what makes the published stream deterministic for any concurrency > 0.
  let publishChain: Promise<void> = Promise.resolve();
  function enqueueFlush(): Promise<void> {
    const next = publishChain.then(() => doFlush());
    publishChain = next.catch(() => {});
    return next;
  }
  async function doFlush(): Promise<void> {
    while (nextToPublish < normalized.length && results[nextToPublish] !== undefined) {
      const outcome = results[nextToPublish];
      if (outcome === undefined) break; // guarded by the loop condition
      if (outcome !== null) {
        pending.push(...outcome.records);
        while (pending.length >= maxBatch) {
          const chunk = pending.splice(0, maxBatch);
          batchNumber += 1;
          await postContracts(chunk, batchNumber);
        }
      }
      nextToPublish += 1;
      if (outcome !== null) {
        const symbol = normalized[nextToPublish - 1];
        // Decoupled underlying snapshot (options.underlying_snapshots) — the
        // run-history half of the retired options.underlyings table. security_id
        // is the deterministic ticker-derived id so it lines up with securities /
        // symbol_history / corporate_actions.
        if (snapshotUrl) {
          await requestJson(
            snapshotUrl,
            [underlyingSnapshot(symbol, outcome.underlying)],
            `${runId}:underlying_snapshot:${symbol}`,
            authToken,
            env,
          );
        }
      }
      // Free this symbol's buffered records now that they've been fully drained
      // into published chunks. Without this the `results` array pins every
      // symbol's parsed contracts for the whole pass, and a large batch (tens of
      // thousands of records) blows the DO isolate's memory limit.
      results[nextToPublish - 1] = undefined;
    }
  }

  async function processSymbol(index: number, symbol: string): Promise<void> {
    const fetchedAt = clock().toISOString();
    try {
      const payload = await fetchChain(symbol, env);
      const { contracts, metadata } = chainRecords(payload);
      const meta = CONSTITUENTS.get(symbol);
      const underlying: Record<string, unknown> = {
        symbol,
        name: meta?.name || symbol,
        sector: meta?.sector || "Unknown",
        spot_price: optionalFloat(first(metadata, "current_price", "spot_price", "price")),
        description: first(metadata, "description", "company_name"),
        run_id: runId,
        as_of_date: asOfDate,
        fetched_at: fetchedAt,
      };
      // Normalize the whole chain locally first: if the symbol ultimately
      // fails, its partial records are discarded (nothing touched shared
      // state), preserving the "a failed symbol publishes nothing" guarantee.
      const symbolRecords: Array<Record<string, unknown>> = [];
      for (const raw of contracts) {
        if (!raw || typeof raw !== "object") throw new Error("contract entry is not an object");
        symbolRecords.push(normalizeContract(raw, symbol, runId, asOfDate, fetchedAt));
      }
      if (symbolRecords.length === 0) throw new Error("CBOE chain contained no contracts");
      results[index] = { records: symbolRecords, underlying };
      await enqueueFlush();
      successfulSymbols += 1;
      contractCount += symbolRecords.length;
    } catch (error) {
      results[index] = null;
      const errorText = errMsg(error);
      failures.push({ symbol, error: errorText });
      errorRecords.push({
        run_id: runId,
        symbol,
        status: "unavailable",
        error: errorText,
        failed_at: clock().toISOString(),
      });
      await enqueueFlush();
    } finally {
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  const sem = semaphore(concurrency);
  await Promise.all(
    normalized.map(async (symbol, index) => {
      await sem.acquire();
      try {
        await processSymbol(index, symbol);
      } finally {
        sem.release();
      }
    }),
  );

  // Publish any trailing prefix after all symbols complete.
  await enqueueFlush();
  if (pending.length > 0) {
    batchNumber += 1;
    await postContracts(pending.splice(0, pending.length), batchNumber);
  }

  run.successful_symbols = successfulSymbols;
  run.contract_count = contractCount;
  run.failed_symbols = failures.length;
  run.completed_at = clock().toISOString();
  run.error_summary = failures.length > 0 ? JSON.stringify(failures) : null;
  run.status = failures.length > 0 ? "failed" : "complete";

  if (errorRecords.length > 0 && errorUrl) {
    await requestJson(errorUrl, errorRecords, `${runId}:errors`, authToken, env);
  }
  await requestJson(runUrl, run, `${runId}:run:final`, authToken, env);

  return { run, failures };
}
