/**
 * On-demand ticker enrollment — bridge from the API Worker to the loader's
 * `POST /symbols/enroll`. When Chat/research hits a ticker outside the
 * bundled lake universe, we enroll it so ETL keeps refreshing it forever.
 */
import universe from "../../loader/symbols/universe.json";
import { isThinBrief } from "./research-commentary";
import type { TickerResearch } from "./research";
import type { SymbolIdentity } from "./symbol-identity";

const BUNDLED = new Set(
  (Array.isArray(universe.symbols) ? universe.symbols : []).map((s: string) =>
    String(s).toUpperCase(),
  ),
);

const LOADER_BASE_DEFAULT = "https://cboe-to-r2.robertlancer.workers.dev";

export interface EnrollEnv {
  LOADER_BASE_URL?: string;
  LOADER_TOKEN?: string;
}

/** full = CBOE/OHLC/research item stores. etf = enrolled_symbols only (etf-daily). */
export type EnrollEtlScope = "full" | "etf";

export interface EnrollRequestOpts {
  source?: string;
  requestedBy?: string | null;
  notes?: string | null;
  /** Default true — kick an immediate CBOE + OHLC load after enrollment. */
  loadNow?: boolean;
  /**
   * full (default) seeds the CBOE options / OHLC / research item stores.
   * etf writes enrolled_symbols for etf-daily only — identifying a private-book
   * fund must not jump the public options tape.
   */
  etlScope?: EnrollEtlScope;
  /** equity | etf | fund — persisted on enrolled_symbols for etf-daily. */
  securityType?: string | null;
  fetchImpl?: typeof fetch;
}

export interface EnrollResponse {
  symbol: string;
  enrolled: boolean;
  already: boolean;
  bundled: boolean;
  enabled: boolean;
  load_now?: boolean;
  error?: string;
}

/** Equity/ETF OCC roots only (no ^VIX / ES=F / BTC-USD). */
export function isEnrollableEquityTicker(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const t = String(raw).trim().toUpperCase();
  if (!t || t.startsWith("^") || t.includes("=") || t.startsWith("/")) return false;
  if (t.endsWith("-USD")) return false;
  return /^[A-Z][A-Z0-9.\-]{0,11}$/.test(t);
}

export function isBundledUniverseTicker(ticker: string): boolean {
  return BUNDLED.has(String(ticker || "").toUpperCase());
}

/**
 * True when research shows the lake has nothing useful for an equity ticker
 * that is not already in the bundled manifest — the signal to enroll.
 */
export function shouldEnrollForMissingLakeData(r: TickerResearch): boolean {
  const ticker = r.identity?.ticker;
  if (!isEnrollableEquityTicker(ticker)) return false;
  if (isBundledUniverseTicker(ticker)) return false;
  return isThinBrief(r);
}

/**
 * POST to the loader enroll endpoint. Returns null when LOADER_TOKEN is unset
 * (dev without secrets) so callers can soft-fail.
 */
export async function enrollTickerWithLoader(
  env: EnrollEnv,
  ticker: string,
  opts: EnrollRequestOpts = {},
): Promise<EnrollResponse | null> {
  const token = (env.LOADER_TOKEN || "").trim();
  if (!token) return null;
  if (!isEnrollableEquityTicker(ticker)) {
    return { symbol: String(ticker || "").toUpperCase(), enrolled: false, already: false, bundled: false, enabled: false, error: "not enrollable" };
  }
  const base = (env.LOADER_BASE_URL || LOADER_BASE_DEFAULT).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(`${base}/symbols/enroll`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "screener-api/enroll",
    },
    body: JSON.stringify({
      symbol: String(ticker).trim().toUpperCase(),
      source: opts.source || "on_demand",
      requested_by: opts.requestedBy || null,
      notes: opts.notes || null,
      load_now: opts.loadNow !== false,
      etl_scope: opts.etlScope || undefined,
      security_type: opts.securityType || undefined,
    }),
  });
  const text = await res.text();
  let body: EnrollResponse = {
    symbol: String(ticker).trim().toUpperCase(),
    enrolled: false,
    already: false,
    bundled: false,
    enabled: false,
  };
  try {
    body = text ? (JSON.parse(text) as EnrollResponse) : body;
  } catch {
    return { ...body, error: `enroll non-JSON (${res.status}): ${text.slice(0, 200)}` };
  }
  if (!res.ok) {
    return { ...body, error: body.error || `enroll HTTP ${res.status}` };
  }
  return body;
}

/**
 * Fire-and-forget enrollment when a research brief is thin and out-of-universe.
 * Never throws; logs failures. Use waitUntil from the Worker/DO when available.
 */
export function maybeEnrollMissingTicker(
  env: EnrollEnv,
  research: TickerResearch,
  opts: {
    source?: string;
    requestedBy?: string | null;
    waitUntil?: (p: Promise<unknown>) => void;
    fetchImpl?: typeof fetch;
  } = {},
): void {
  if (!shouldEnrollForMissingLakeData(research)) return;
  const ticker = research.identity.ticker;
  const task = enrollTickerWithLoader(env, ticker, {
    source: opts.source || "research_missing",
    requestedBy: opts.requestedBy || null,
    notes: "auto-enrolled: thin research brief / missing lake data",
    loadNow: true,
    fetchImpl: opts.fetchImpl,
  }).then((result) => {
    if (result?.error) {
      console.error("ticker enroll failed", ticker, result.error);
    } else if (result) {
      console.log(JSON.stringify({
        event: "ticker_enrolled",
        symbol: result.symbol,
        already: result.already,
        source: opts.source || "research_missing",
      }));
    }
  }).catch((e) => {
    console.error("ticker enroll error", ticker, e);
  });
  if (opts.waitUntil) opts.waitUntil(task);
}

/**
 * Enroll a looked-up ETF/fund so etf-daily writes profile + top holdings
 * to the lake. Does not seed the CBOE options / OHLC item stores — identifying
 * a private-book fund must not jump the public tape. Bundled optionable ETFs
 * are already in etfs.json. Never throws.
 */
export function maybeEnrollIdentifiedFund(
  env: EnrollEnv,
  identity: SymbolIdentity,
  opts: {
    source?: string;
    requestedBy?: string | null;
    waitUntil?: (p: Promise<unknown>) => void;
    fetchImpl?: typeof fetch;
  } = {},
): void {
  if (identity.kind !== "etf" && identity.kind !== "fund") return;
  if (!isEnrollableEquityTicker(identity.symbol)) return;
  if (isBundledUniverseTicker(identity.symbol)) return;
  const ticker = identity.symbol;
  const name = identity.name ? ` (${identity.name})` : "";
  const task = enrollTickerWithLoader(env, ticker, {
    source: opts.source || "lookup_symbols",
    requestedBy: opts.requestedBy || null,
    notes: `auto-enrolled: ${identity.kind}${name} holdings ingest`.slice(0, 512),
    securityType: "etf",
    etlScope: "etf",
    loadNow: false,
    fetchImpl: opts.fetchImpl,
  }).then((result) => {
    if (result?.error) {
      console.error("fund enroll failed", ticker, result.error);
    } else if (result) {
      console.log(JSON.stringify({
        event: "ticker_enrolled",
        symbol: result.symbol,
        already: result.already,
        security_type: "etf",
        source: opts.source || "lookup_symbols",
      }));
    }
  }).catch((e) => {
    console.error("fund enroll error", ticker, e);
  });
  if (opts.waitUntil) opts.waitUntil(task);
}
