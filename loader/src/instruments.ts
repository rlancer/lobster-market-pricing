// Instrument classification dimension for the options lake.
//
// options.ohlc holds bars for equities, ETFs, indexes, continuous futures, and
// spot crypto — but the bar table itself has no type tag, so analysts were
// forced to hand-list ETF tickers. This module publishes options.instruments:
// one row per symbol with an extendable security_type (equity | etf | index |
// future | crypto | …) plus optional asset_class / source. Join on symbol:
//
//   SELECT o.symbol, MIN(o.date) AS first_date, MAX(o.date) AS last_date, COUNT(*) AS bars
//   FROM options.ohlc o
//   JOIN (
//     SELECT symbol, security_type
//     FROM options.instruments
//     QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fetched_at DESC) = 1
//   ) i ON i.symbol = o.symbol
//   WHERE i.security_type = 'etf' AND o.date >= '2026-06-01'
//   GROUP BY o.symbol
//   ORDER BY o.symbol
//   LIMIT 40
//
// Catalog is built from the loader manifests (no live Yahoo/FIGI fetch). New
// security_type values are free strings — add a constant + manifest mapping;
// no Iceberg schema change required.

import { securityIdForTicker } from "./symbology.js";
import universe from "../symbols/universe.json";
import etfs from "../symbols/etfs.json";
import indices from "../symbols/indices.json";
import futures from "../symbols/futures.json";
import cryptoSpot from "../symbols/crypto-spot.json";

export const INSTRUMENTS_SOURCE = "manifest";

/** Extendable instrument kinds. Prefer these constants when publishing. */
export const SECURITY_TYPES = {
  equity: "equity",
  etf: "etf",
  index: "index",
  future: "future",
  crypto: "crypto",
} as const;

export type SecurityType = (typeof SECURITY_TYPES)[keyof typeof SECURITY_TYPES];

export const INSTRUMENT_FIELDS = [
  "symbol",
  "ticker",
  "security_id",
  "name",
  "security_type",
  "asset_class",
  "source",
  "run_id",
  "as_of_date",
  "fetched_at",
] as const;

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;

export interface InstrumentsEnv {
  PIPELINE_INSTRUMENTS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  now?: () => Date;
  runId?: () => string;
}

export interface InstrumentRow {
  symbol: string;
  ticker: string;
  security_id: string;
  name: string | null;
  security_type: string;
  asset_class: string | null;
  source: string | null;
  run_id: string;
  as_of_date: string;
  fetched_at: string;
}

export interface InstrumentSpec {
  symbol: string;
  name?: string | null;
  security_type: string;
  asset_class?: string | null;
  source?: string | null;
}

export interface InstrumentsPublishResult {
  row_count: number;
  published: boolean;
  run_id: string;
  fetched_at: string;
}

type Constituent = { name?: string; sector?: string; source?: string };

const CONSTITUENTS = (universe.constituents ?? {}) as Record<string, Constituent>;
const ETF_ROWS: Array<{ symbol: string; name?: string; asset_class?: string }> = Array.isArray(
  etfs.etfs,
)
  ? etfs.etfs
  : [];
const INDEX_ROWS: Array<{ symbol: string; name?: string; family?: string }> = Array.isArray(
  indices.indices,
)
  ? indices.indices
  : [];
const FUTURE_ROWS: Array<{
  symbol: string;
  name?: string;
  asset_class?: string;
}> = Array.isArray(futures.futures) ? futures.futures : [];
const CRYPTO_ROWS: Array<{
  symbol: string;
  name?: string;
  asset_class?: string;
}> = Array.isArray(cryptoSpot.cryptos) ? cryptoSpot.cryptos : [];

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function num(v: number | undefined, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffSeconds(env: InstrumentsEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function stripNones(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNones);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null && v !== undefined) out[key] = v;
    }
    return out;
  }
  return value;
}

function project(rec: InstrumentRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of INSTRUMENT_FIELDS) out[f] = rec[f];
  return out;
}

/** Map universe constituent source → security_type. */
export function securityTypeFromUniverseSource(source: string | null | undefined): SecurityType {
  const s = String(source || "").toLowerCase();
  if (s === "etf") return SECURITY_TYPES.etf;
  return SECURITY_TYPES.equity;
}

/**
 * Build the full instrument catalog from loader manifests (+ optional enrolled
 * equity tickers). Later sources win on symbol collision so dedicated
 * manifests (indices / futures / crypto) override the equity/ETF universe.
 */
export function buildInstrumentCatalog(enrolled: string[] = []): InstrumentSpec[] {
  const bySymbol = new Map<string, InstrumentSpec>();

  const upsert = (spec: InstrumentSpec) => {
    const symbol = String(spec.symbol || "").trim().toUpperCase();
    if (!symbol) return;
    bySymbol.set(symbol, {
      symbol,
      name: spec.name ?? null,
      security_type: spec.security_type,
      asset_class: spec.asset_class ?? null,
      source: spec.source ?? null,
    });
  };

  for (const raw of Array.isArray(universe.symbols) ? universe.symbols : []) {
    const symbol = String(raw || "").trim().toUpperCase();
    if (!symbol) continue;
    const cons = CONSTITUENTS[symbol] ?? {};
    const source = typeof cons.source === "string" ? cons.source : "sp500";
    upsert({
      symbol,
      name: typeof cons.name === "string" ? cons.name : symbol,
      security_type: securityTypeFromUniverseSource(source),
      // ETF sleeves store asset class in constituents.sector (Broad Market, …).
      // Equities keep asset_class null — GICS sector lives on securities /
      // underlying_snapshots, not here.
      asset_class:
        source === "etf" && typeof cons.sector === "string" ? cons.sector : null,
      source,
    });
  }

  // Prefer etfs.json asset_class when present (canonical curated label).
  for (const row of ETF_ROWS) {
    const symbol = String(row.symbol || "").trim().toUpperCase();
    if (!symbol) continue;
    const prev = bySymbol.get(symbol);
    upsert({
      symbol,
      name: row.name ?? prev?.name ?? symbol,
      security_type: SECURITY_TYPES.etf,
      asset_class: row.asset_class ?? prev?.asset_class ?? null,
      source: "etf",
    });
  }

  for (const symbol of enrolled) {
    const sym = String(symbol || "").trim().toUpperCase();
    if (!sym || bySymbol.has(sym)) continue;
    upsert({
      symbol: sym,
      name: sym,
      security_type: SECURITY_TYPES.equity,
      asset_class: null,
      source: "enrolled",
    });
  }

  for (const row of INDEX_ROWS) {
    upsert({
      symbol: row.symbol,
      name: row.name ?? row.symbol,
      security_type: SECURITY_TYPES.index,
      asset_class: row.family ?? "Index",
      source: "indices",
    });
  }

  for (const row of FUTURE_ROWS) {
    upsert({
      symbol: row.symbol,
      name: row.name ?? row.symbol,
      security_type: SECURITY_TYPES.future,
      asset_class: row.asset_class ?? null,
      source: "futures",
    });
  }

  for (const row of CRYPTO_ROWS) {
    upsert({
      symbol: row.symbol,
      name: row.name ?? row.symbol,
      security_type: SECURITY_TYPES.crypto,
      asset_class: row.asset_class ?? "Crypto",
      source: "crypto-spot",
    });
  }

  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function normalizeInstrumentRecords(
  specs: InstrumentSpec[],
  runId: string,
  fetchedAt: string,
): InstrumentRow[] {
  const asOfDate = fetchedAt.slice(0, 10);
  return specs.map((spec) => {
    const symbol = String(spec.symbol).trim().toUpperCase();
    return {
      symbol,
      ticker: symbol,
      security_id: securityIdForTicker(symbol),
      name: spec.name && String(spec.name).trim() ? String(spec.name).trim() : null,
      security_type: String(spec.security_type).trim().toLowerCase(),
      asset_class:
        spec.asset_class && String(spec.asset_class).trim()
          ? String(spec.asset_class).trim()
          : null,
      source: spec.source && String(spec.source).trim() ? String(spec.source).trim() : null,
      run_id: runId,
      as_of_date: asOfDate,
      fetched_at: fetchedAt,
    };
  });
}

async function requestJson(
  url: string,
  payload: unknown,
  idempotencyKey: string,
  authToken: string,
  env: InstrumentsEnv,
): Promise<void> {
  if (!url) return;
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const body = JSON.stringify(stripNones(payload));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "cboe-to-r2/0.2",
  };
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
    headers["idempotency-key"] = idempotencyKey;
  }
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
    if (code < 500) throw lastError;
    if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
  }
  throw new Error(`pipeline request failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

/**
 * Publish the full instrument catalog in one Pipeline POST. Chunking is
 * unnecessary at current universe size (~650 rows); revisit if manifests grow
 * past a few thousand.
 */
export async function publishInstruments(
  env: InstrumentsEnv = {},
  enrolled: string[] = [],
): Promise<InstrumentsPublishResult> {
  const url = env.PIPELINE_INSTRUMENTS_URL || "";
  if (!url) {
    throw new Error("instruments publish requires PIPELINE_INSTRUMENTS_URL");
  }
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = new Date(env.now ? env.now() : Date.now()).toISOString();
  const rows = normalizeInstrumentRecords(buildInstrumentCatalog(enrolled), runId, fetchedAt);
  if (rows.length === 0) {
    return { row_count: 0, published: false, run_id: runId, fetched_at: fetchedAt };
  }
  await requestJson(
    url,
    rows.map(project),
    `instruments:${runId}`,
    env.PIPELINE_AUTH_TOKEN || "",
    env,
  );
  return { row_count: rows.length, published: true, run_id: runId, fetched_at: fetchedAt };
}
