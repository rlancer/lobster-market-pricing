// Curated Kalshi event-contract snapshots for the options lake.
//
// Investing series (Fed/CPI/indexes/crypto/oil) come from symbols/kalshi-series.json
// as series_ticker GETs. Sports parlays are the KXMVE ingest: open multivariate
// combo markets plus the legs those combos select — not the full sports catalog —
// and ~30 days of daily candlesticks for those tickers (settled/closed MVE in
// the window). Candle rows set fetched_at to the period end so latest-wins
// keeps quote history; settlement 0/1 is a separate source=kalshi_settlement
// row (not mixed into candles) so the parlay backtest can grade fills.
// Publishes to options.kalshi_markets via PIPELINE_KALSHI_MARKETS_URL.
//
// Public Trade API (no auth for market data):
//   https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=…&status=open
// Optional RFQ probe (KALSHI_RFQ_PROBE_ENABLED): POST /communications/rfqs on a
// capped same-game sports set, GET quotes, DELETE the RFQ — never accept.
// Pure module (fetch / crypto only) so Vitest and the DO share one path.

import seriesManifest from "../symbols/kalshi-series.json" with { type: "json" };
import {
  encodeMveCategory,
  isSameGameSportsTwoLeg,
  isSportsParlayCandidate,
  mveCollectionTicker,
  parseMveSelectedLegs,
  seriesTickerFromMarketTicker,
  type MveSelectedLeg,
} from "./kalshi-mve.js";
import { probeKalshiRfqQuotes } from "./kalshi-rfq-quotes.js";
import {
  asSettlementSnapshot,
  isKalshiSettledStatus,
  kalshiResultYes,
  looksLikeSettlementPrint,
} from "./kalshi-settlement.js";

export {
  encodeMveCategory,
  parseMveCategory,
  parseMveSelectedLegs,
  parlayGameGroup,
  eventPrefixFromTicker,
  isSameGameSportsTwoLeg,
  sportsGameKey,
} from "./kalshi-mve.js";

// ---------------------------------------------------------------------------
// Manifest / allowlist
// ---------------------------------------------------------------------------
export type KalshiTheme =
  | "rates"
  | "inflation"
  | "growth"
  | "equity_index"
  | "crypto"
  | "commodity"
  | "sports";

export interface KalshiSeriesMeta {
  series_ticker: string;
  theme: KalshiTheme;
  title: string;
  related_symbol: string | null;
  max_markets?: number;
  /** series = GET /markets?series_ticker= (default). mve = sports parlays + legs. */
  ingest?: "series" | "mve";
}

interface KalshiManifestFile {
  api_base?: string;
  max_markets_per_series_default?: number;
  series: KalshiSeriesMeta[];
}

const MANIFEST = seriesManifest as KalshiManifestFile;

export const KALSHI_SERIES: Record<string, KalshiSeriesMeta> = Object.fromEntries(
  (MANIFEST.series || []).map((s) => [s.series_ticker, s]),
);

export const DEFAULT_KALSHI_API_BASE =
  MANIFEST.api_base || "https://api.elections.kalshi.com/trade-api/v2";

export const DEFAULT_MAX_MARKETS_PER_SERIES =
  typeof MANIFEST.max_markets_per_series_default === "number"
    && Number.isFinite(MANIFEST.max_markets_per_series_default)
    && MANIFEST.max_markets_per_series_default > 0
    ? Math.floor(MANIFEST.max_markets_per_series_default)
    : 80;

export const KALSHI_SOURCE = "kalshi";

export const KALSHI_MARKETS_FIELDS = [
  "series_ticker", "market_ticker", "event_ticker", "title", "yes_subtitle",
  "theme", "category", "status", "market_type",
  "yes_bid", "yes_ask", "yes_last", "no_bid", "no_ask",
  "volume", "volume_24h", "open_interest", "liquidity", "floor_strike",
  "close_time", "expiration_time", "related_symbol",
  "source", "run_id", "fetched_at",
] as const;

export const HTTP_RETRIES_DEFAULT = 2;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 20;
export const PAGE_LIMIT_DEFAULT = 200;
/** Cap pages — with limit=200 most series fit in 1–2 pages; fewer calls → fewer 429s. */
export const MAX_PAGES_DEFAULT = 3;
/** Floor gap between any two Kalshi GETs in this isolate (ms). */
export const MIN_REQUEST_GAP_MS_DEFAULT = 400;
/** Cap a single 429 sleep so one hot series cannot burn the whole pass budget. */
export const MAX_429_WAIT_SECONDS = 12;
/** Default sports-parlay candlestick lookback (days). */
export const KALSHI_SPORTS_LOOKBACK_DAYS_DEFAULT = 30;
/** Cap settled/closed sports combos pulled in that window. */
export const KALSHI_SPORTS_LOOKBACK_MAX_DEFAULT = 200;
/** Daily candles — Kalshi period_interval minutes. */
export const KALSHI_CANDLE_INTERVAL_MIN = 1440;
/** Batch Get Market Candlesticks allows 100 tickers; stay under the 10k-candle cap. */
export const KALSHI_CANDLE_TICKER_BATCH = 80;
/** Pipelines HTTP ingest rejects bodies over 5 MB (KXMVE candles 413'd). */
export const PIPELINE_MAX_BODY_BYTES_DEFAULT = 4_500_000;

export interface KalshiEnv {
  KALSHI_API_BASE?: string;
  /** Set to "1" to also fetch Get Series for category enrichment (extra API call). */
  KALSHI_FETCH_SERIES_META?: string;
  /**
   * Optional Kalshi API Key ID (UUID from Account → API Keys).
   * With KALSHI_PRIVATE_KEY_PEM, market GETs are RSA-PSS signed — higher rate
   * tiers than anonymous public GETs. Read-only keys are fine for GETs.
   * Create RFQ (sports quote probe) needs trading permission; 403 skips the probe.
   */
  KALSHI_ACCESS_KEY_ID?: string;
  /**
   * Optional RSA private key PEM (PKCS#1 or PKCS#8). Wrangler secret only —
   * never commit. Pair with KALSHI_ACCESS_KEY_ID.
   */
  KALSHI_PRIVATE_KEY_PEM?: string;
  /**
   * Set to "1" to solicit RFQ quotes on a capped set of same-game sports
   * parlays during the KXMVE pass. Requires trading-capable API keys.
   * Quotes are mapped onto yes_bid/yes_ask; the RFQ is always cancelled.
   */
  KALSHI_RFQ_PROBE_ENABLED?: string;
  /** Max same-game two-leg combos to RFQ per pass (default 12, cap 20). */
  KALSHI_RFQ_PROBE_MAX?: number | string;
  /** Ms to wait after Create RFQ before the first quote poll (default 2500). */
  KALSHI_RFQ_WAIT_MS?: number | string;
  /** Ms between subsequent quote polls (default 1000). */
  KALSHI_RFQ_POLL_MS?: number | string;
  /** Quote poll attempts per RFQ (default 3). */
  KALSHI_RFQ_POLLS?: number | string;
  /** Whole-contract RFQ size (default 10, cap 10). $1 face → $10 notional. */
  KALSHI_RFQ_CONTRACTS?: number | string;
  /**
   * Set to "1" to run kalshi-parlay-executor (RFQ + score).
   * Does not accept quotes unless KALSHI_PARLAY_LIVE is also "1".
   */
  KALSHI_PARLAY_EXECUTE?: string;
  /**
   * Set to "1" with KALSHI_PARLAY_EXECUTE to accept YES on passing RFQs.
   * The maker confirms (HVM). The research probe never accepts.
   */
  KALSHI_PARLAY_LIVE?: string;
  /** Executor cadence seconds (default 300). */
  KALSHI_PARLAY_CADENCE_SECONDS?: number | string;
  /** Live fills allowed per 5-minute pass (default 1, cap 12). */
  KALSHI_PARLAY_MAX_ACCEPTS_PER_PASS?: number | string;
  PIPELINE_KALSHI_MARKETS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  /** Max JSON body bytes per pipeline POST (default 4.5 MiB, under the 5 MB cap). */
  KALSHI_PIPELINE_MAX_BODY_BYTES?: number | string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  KALSHI_MAX_MARKETS?: number;
  KALSHI_PAGE_LIMIT?: number;
  KALSHI_MAX_PAGES?: number;
  /** Min ms between Kalshi GETs (default 400). */
  KALSHI_MIN_REQUEST_GAP_MS?: number;
  /**
   * Sports-parlay history window in days (default 30). Daily candlesticks for
   * open + settled/closed MVE combos and their selected legs. 0 = open only.
   */
  KALSHI_SPORTS_LOOKBACK_DAYS?: number | string;
  /** Cap on settled/closed sports combos in the lookback window (default 200). */
  KALSHI_SPORTS_LOOKBACK_MAX?: number | string;
  now?: () => number;
  runId?: () => string;
}

export interface KalshiMarketRow {
  series_ticker: string;
  market_ticker: string;
  event_ticker: string | null;
  title: string;
  yes_subtitle: string | null;
  theme: KalshiTheme;
  category: string | null;
  status: string;
  market_type: string | null;
  yes_bid: number | null;
  yes_ask: number | null;
  yes_last: number | null;
  no_bid: number | null;
  no_ask: number | null;
  volume: number | null;
  volume_24h: number | null;
  open_interest: number | null;
  liquidity: number | null;
  floor_strike: number | null;
  close_time: string | null;
  expiration_time: string | null;
  related_symbol: string | null;
  source: string;
  /** Per-row event time. Candle rows set this to the period end. */
  fetched_at?: string;
}

export interface KalshiPublishResult {
  item: string; // series_ticker
  row_count: number;
  published: boolean;
  run_id: string;
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function num(v: number | undefined, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
}

function envNumber(raw: unknown, dflt: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}

function envInt(raw: unknown, dflt: number, min: number, max: number): number {
  const n = envNumber(raw, dflt);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function kalshiSportsLookbackDays(env: KalshiEnv): number {
  return envInt(env.KALSHI_SPORTS_LOOKBACK_DAYS, KALSHI_SPORTS_LOOKBACK_DAYS_DEFAULT, 0, 90);
}

function kalshiSportsLookbackMax(env: KalshiEnv): number {
  return envInt(env.KALSHI_SPORTS_LOOKBACK_MAX, KALSHI_SPORTS_LOOKBACK_MAX_DEFAULT, 1, 500);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Serialize Kalshi GETs inside one DO/pass so bursts don't trip 429. */
let lastKalshiRequestAt = 0;

async function paceKalshiRequest(env: KalshiEnv): Promise<void> {
  const gap = Math.floor(num(env.KALSHI_MIN_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS_DEFAULT));
  if (gap <= 0) return;
  const now = Date.now();
  const wait = lastKalshiRequestAt + gap - now;
  if (wait > 0) await sleep(wait);
  lastKalshiRequestAt = Date.now();
}

function retryWaitSeconds(env: KalshiEnv, attempt: number, status: number, retryAfterHeader: string | null): number {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter, MAX_429_WAIT_SECONDS);
  }
  // Kalshi often omits Retry-After. Cap waits so 429 storms fail the series
  // quickly and the pass can finish remaining tickers inside LOADER_RUN_TIMEOUT
  // (a 600s abort previously zeroed the whole allowlist).
  if (status === 429) {
    return Math.min(MAX_429_WAIT_SECONDS, Math.max(backoffSeconds(env, attempt), 3 * 2 ** attempt));
  }
  return backoffSeconds(env, attempt);
}

// ---------------------------------------------------------------------------
// Optional RSA-PSS auth (Kalshi API Key ID + private key PEM)
// ---------------------------------------------------------------------------
function decodePemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (!b64) throw new Error("kalshi auth: empty private key PEM");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function asn1Length(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  if (n < 0x100) return Uint8Array.of(0x81, n);
  if (n < 0x10000) return Uint8Array.of(0x82, (n >> 8) & 0xff, n & 0xff);
  throw new Error("kalshi auth: DER length too large");
}

function asn1Wrap(tag: number, content: Uint8Array): Uint8Array {
  const len = asn1Length(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

/** Wrap PKCS#1 RSAPrivateKey DER in a PKCS#8 PrivateKeyInfo for Web Crypto. */
function pkcs1DerToPkcs8Der(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  // AlgorithmIdentifier: rsaEncryption OID 1.2.840.113549.1.1.1 + NULL
  const algId = Uint8Array.of(
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  );
  const octet = asn1Wrap(0x04, pkcs1);
  const body = new Uint8Array(version.length + algId.length + octet.length);
  body.set(version, 0);
  body.set(algId, version.length);
  body.set(octet, version.length + algId.length);
  return asn1Wrap(0x30, body);
}

function privateKeyPemToPkcs8Der(pem: string): Uint8Array {
  const trimmed = pem.trim();
  const der = decodePemToDer(trimmed);
  if (trimmed.includes("BEGIN RSA PRIVATE KEY")) return pkcs1DerToPkcs8Der(der);
  if (trimmed.includes("BEGIN PRIVATE KEY")) return der;
  throw new Error("kalshi auth: PEM must be BEGIN PRIVATE KEY or BEGIN RSA PRIVATE KEY");
}

let cachedKeyPem: string | null = null;
let cachedCryptoKey: CryptoKey | null = null;

async function importKalshiPrivateKey(pem: string): Promise<CryptoKey> {
  if (cachedCryptoKey && cachedKeyPem === pem) return cachedCryptoKey;
  const pkcs8 = privateKeyPemToPkcs8Der(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8.slice().buffer,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedKeyPem = pem;
  cachedCryptoKey = key;
  return key;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

/** Path to sign: full URL pathname without query (e.g. /trade-api/v2/markets). */
export function kalshiSignPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const noQuery = url.split("?")[0] || url;
    const idx = noQuery.indexOf("/trade-api/");
    return idx >= 0 ? noQuery.slice(idx) : noQuery;
  }
}

export function kalshiAuthConfigured(env: KalshiEnv): boolean {
  return !!(strip(env.KALSHI_ACCESS_KEY_ID) && strip(env.KALSHI_PRIVATE_KEY_PEM));
}

/**
 * Build Kalshi signed access headers for one request.
 * See https://docs.kalshi.com/getting_started/quick_start_authenticated_requests
 */
export async function buildKalshiAuthHeaders(
  method: string,
  url: string,
  env: KalshiEnv,
): Promise<Record<string, string> | null> {
  const keyId = strip(env.KALSHI_ACCESS_KEY_ID);
  const pem = strip(env.KALSHI_PRIVATE_KEY_PEM);
  if (!keyId || !pem) return null;
  const timestamp = String(env.now ? env.now() : Date.now());
  const path = kalshiSignPath(url);
  const message = `${timestamp}${method.toUpperCase()}${path}`;
  const key = await importKalshiPrivateKey(pem);
  const signature = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    key,
    new TextEncoder().encode(message),
  );
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": bytesToBase64(signature),
  };
}

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

/**
 * Split pipeline records so each JSON POST stays under the ingest body cap.
 * A single oversized row is still sent alone (dropping it would hide data).
 */
export function chunkKalshiPipelineRecords(
  records: Array<Record<string, unknown>>,
  maxBodyBytes: number = PIPELINE_MAX_BODY_BYTES_DEFAULT,
): Array<Array<Record<string, unknown>>> {
  const max = Math.max(1, Math.floor(maxBodyBytes));
  const chunks: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];
  let size = 2;
  for (const rec of records) {
    const piece = JSON.stringify(stripNones(rec));
    const extra = (current.length > 0 ? 1 : 0) + piece.length;
    if (current.length > 0 && size + extra > max) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    if (current.length === 0 && 2 + piece.length > max) {
      chunks.push([rec]);
      continue;
    }
    current.push(rec);
    size += extra;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function backoffSeconds(env: KalshiEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

/** Parse Kalshi dollar strings ("0.1700") or numbers → float, else null. */
export function parseKalshiNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const s = strip(raw);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function kalshiSeriesList(): string[] {
  return Object.keys(KALSHI_SERIES);
}

export function investingKalshiSeries(): Set<string> {
  return new Set(
    Object.values(KALSHI_SERIES)
      .filter((meta) => meta.theme !== "sports" && meta.ingest !== "mve")
      .map((meta) => meta.series_ticker),
  );
}

function maxMarketsFor(seriesId: string, env: KalshiEnv): number {
  const meta = KALSHI_SERIES[seriesId];
  const fromEnv = env.KALSHI_MAX_MARKETS;
  if (typeof fromEnv === "number" && Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  if (meta?.max_markets && meta.max_markets > 0) return Math.floor(meta.max_markets);
  return DEFAULT_MAX_MARKETS_PER_SERIES;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
export interface KalshiHttpResult {
  status: number;
  json: unknown;
  text: string;
}

/** Signed Kalshi Trade API call. Retries 429/5xx. Returns 4xx to the caller. */
export async function kalshiRequest(
  method: string,
  url: string,
  env: KalshiEnv,
  label: string,
  body?: unknown,
): Promise<KalshiHttpResult> {
  const verb = method.toUpperCase();
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const timeoutMs = Math.floor(num(env.REQUEST_TIMEOUT, REQUEST_TIMEOUT_SECONDS_DEFAULT) * 1000);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let controller: AbortController | null = null;
    try {
      await paceKalshiRequest(env);
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      try {
        const headers: Record<string, string> = {
          accept: "application/json",
          "user-agent": "cboe-to-r2/0.2",
        };
        if (payload !== undefined) headers["content-type"] = "application/json";
        try {
          const auth = await buildKalshiAuthHeaders(verb, url, env);
          if (auth) Object.assign(headers, auth);
        } catch (authError) {
          throw new Error(`kalshi auth sign failed: ${errMsg(authError)}`);
        }
        const response = await fetch(url, {
          method: verb,
          headers,
          body: payload,
          signal: controller.signal,
        });
        const text = await response.text();
        let json: unknown = null;
        if (text) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
        const result: KalshiHttpResult = { status: response.status, json, text };
        if (response.ok || response.status === 204) return result;
        const code = response.status;
        lastError = new Error(`${label} returned HTTP ${code}: ${text.slice(0, 160)}`);
        if (code !== 429 && code < 500) return result;
        if (attempt < retries) {
          const waitSec = retryWaitSeconds(env, attempt, code, response.headers.get("retry-after"));
          await sleep(waitSec * 1000);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /kalshi auth sign failed/.test(error.message)) {
        throw error;
      }
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
    }
  }
  throw new Error(`${label} failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

async function fetchJson(url: string, env: KalshiEnv, label: string): Promise<unknown> {
  const result = await kalshiRequest("GET", url, env, label);
  if (result.status >= 200 && result.status < 300) return result.json;
  throw new Error(`${label} returned HTTP ${result.status}: ${result.text.slice(0, 160)}`);
}

async function requestJson(
  url: string,
  body: unknown,
  idempotencyKey: string,
  authToken: string,
  env: KalshiEnv,
): Promise<void> {
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const payload = JSON.stringify(stripNones(body));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "cboe-to-r2/0.2",
    "idempotency-key": idempotencyKey,
  };
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: payload });
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
  throw new Error(
    `pipeline request failed after ${retries + 1} attempts: ${errMsg(lastError)}`,
  );
}

// ---------------------------------------------------------------------------
// Parse + rank
// ---------------------------------------------------------------------------
/** Prefer liquid / soon-to-close markets when capping a busy series. */
export function rankKalshiMarkets(rows: KalshiMarketRow[]): KalshiMarketRow[] {
  return [...rows].sort((a, b) => {
    const volA = a.volume_24h ?? a.volume ?? 0;
    const volB = b.volume_24h ?? b.volume ?? 0;
    if (volB !== volA) return volB - volA;
    const closeA = a.close_time || "9999";
    const closeB = b.close_time || "9999";
    if (closeA !== closeB) return closeA < closeB ? -1 : 1;
    return a.market_ticker < b.market_ticker ? -1 : a.market_ticker > b.market_ticker ? 1 : 0;
  });
}

export function mapKalshiMarketRaw(
  raw: unknown,
  defaults: {
    series_ticker?: string;
    theme: KalshiTheme;
    related_symbol: string | null;
    category?: string | null;
    market_type?: string | null;
  },
): KalshiMarketRow | null {
  const m = asRecord(raw);
  if (!m) return null;
  const market_ticker = strip(m.ticker).toUpperCase();
  if (!market_ticker) return null;
  const series_ticker = (defaults.series_ticker
    || strip(m.series_ticker).toUpperCase()
    || seriesTickerFromMarketTicker(market_ticker));
  const status = strip(m.status) || "unknown";
  const last = parseKalshiNumber(m.last_price_dollars ?? m.last_price);
  const resultYes = isKalshiSettledStatus(status) ? kalshiResultYes(m.result) : null;
  return {
    series_ticker,
    market_ticker,
    event_ticker: strip(m.event_ticker) || null,
    title: strip(m.title) || market_ticker,
    yes_subtitle: strip(m.yes_sub_title) || strip(m.subtitle) || null,
    theme: defaults.theme,
    category: defaults.category ?? null,
    status,
    market_type: defaults.market_type || strip(m.market_type) || null,
    yes_bid: parseKalshiNumber(m.yes_bid_dollars ?? m.yes_bid),
    yes_ask: parseKalshiNumber(m.yes_ask_dollars ?? m.yes_ask),
    yes_last: last ?? resultYes,
    no_bid: parseKalshiNumber(m.no_bid_dollars ?? m.no_bid),
    no_ask: parseKalshiNumber(m.no_ask_dollars ?? m.no_ask),
    volume: parseKalshiNumber(m.volume_fp ?? m.volume),
    volume_24h: parseKalshiNumber(m.volume_24h_fp ?? m.volume_24h),
    open_interest: parseKalshiNumber(m.open_interest_fp ?? m.open_interest),
    liquidity: parseKalshiNumber(m.liquidity_dollars ?? m.liquidity),
    floor_strike: parseKalshiNumber(m.floor_strike),
    close_time: strip(m.close_time) || null,
    expiration_time: strip(m.expiration_time) || strip(m.expected_expiration_time) || null,
    related_symbol: defaults.related_symbol,
    source: KALSHI_SOURCE,
  };
}

export function parseKalshiMarketsPayload(
  seriesId: string,
  payload: unknown,
): KalshiMarketRow[] {
  const meta = KALSHI_SERIES[seriesId];
  if (!meta) throw new Error(`kalshi: unknown series_ticker ${seriesId}`);
  const markets = asRecord(payload)?.markets;
  if (!Array.isArray(markets)) return [];
  const out: KalshiMarketRow[] = [];
  const seen = new Set<string>();
  for (const raw of markets) {
    const mapped = mapKalshiMarketRaw(raw, {
      series_ticker: seriesId,
      theme: meta.theme,
      related_symbol: meta.related_symbol,
    });
    if (!mapped || seen.has(mapped.market_ticker)) continue;
    seen.add(mapped.market_ticker);
    out.push(mapped);
  }
  return out;
}

/** Attach series category from Get Series when available (optional enrichment). */
export function applySeriesCategory(
  rows: KalshiMarketRow[],
  seriesPayload: unknown,
): KalshiMarketRow[] {
  const series = asRecord(asRecord(seriesPayload)?.series) || asRecord(seriesPayload);
  const category = strip(series?.category) || null;
  if (!category) return rows;
  return rows.map((r) => ({ ...r, category }));
}

async function fetchKalshiPage(
  url: string,
  env: KalshiEnv,
  label: string,
): Promise<{ markets: unknown[]; cursor: string }> {
  const payload = await fetchJson(url, env, label);
  const rec = asRecord(payload);
  const markets = rec?.markets;
  return {
    markets: Array.isArray(markets) ? markets : [],
    cursor: strip(rec?.cursor),
  };
}

async function fetchMarketsByTickers(
  tickers: string[],
  env: KalshiEnv,
): Promise<KalshiMarketRow[]> {
  const base = (env.KALSHI_API_BASE || DEFAULT_KALSHI_API_BASE).replace(/\/$/, "");
  const unique = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  const out: KalshiMarketRow[] = [];
  const seen = new Set<string>();
  const chunkSize = 20;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const url = `${base}/markets?tickers=${encodeURIComponent(chunk.join(","))}&limit=200`;
    const page = await fetchKalshiPage(url, env, `kalshi markets tickers ${i}`);
    for (const raw of page.markets) {
      const mapped = mapKalshiMarketRaw(raw, {
        theme: "sports",
        related_symbol: null,
      });
      if (!mapped || seen.has(mapped.market_ticker)) continue;
      seen.add(mapped.market_ticker);
      out.push(mapped);
    }
  }
  return out;
}

type MveLegList = ReturnType<typeof parseMveSelectedLegs>;

function kalshiPageLimit(env: KalshiEnv): number {
  return Math.min(1000, Math.max(1, Math.floor(num(env.KALSHI_PAGE_LIMIT, PAGE_LIMIT_DEFAULT))));
}

function kalshiMaxPages(env: KalshiEnv): number {
  return Math.max(1, Math.floor(num(env.KALSHI_MAX_PAGES, MAX_PAGES_DEFAULT)));
}


function candleCloseDollars(raw: unknown): number | null {
  const rec = asRecord(raw);
  if (!rec) return parseKalshiNumber(raw);
  return parseKalshiNumber(rec.close_dollars ?? rec.close);
}

async function fetchMveRawMarkets(
  env: KalshiEnv,
  status: "open" | "settled" | "closed",
  extraQuery = "",
): Promise<unknown[]> {
  const base = (env.KALSHI_API_BASE || DEFAULT_KALSHI_API_BASE).replace(/\/$/, "");
  const pageLimit = kalshiPageLimit(env);
  const maxPages = kalshiMaxPages(env);
  const raw: unknown[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    let url = `${base}/markets?mve_filter=only&status=${status}&limit=${pageLimit}${extraQuery}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const batch = await fetchKalshiPage(url, env, `kalshi mve ${status} p${page}`);
    raw.push(...batch.markets);
    if (!batch.cursor || batch.markets.length === 0) break;
    cursor = batch.cursor;
  }
  return raw;
}

/**
 * Sports MVE combos from Get Markets. Hourly lake ingest passes a volume cap
 * (KXMVE max_markets = 80). The live executor passes null so empty-CLOB
 * same-game two-legs (volume 0) are not dropped.
 */
export function collectSportsCombos(
  rawMarkets: unknown[],
  investing: ReadonlySet<string>,
  cap: number | null,
): { ranked: KalshiMarketRow[]; comboLegs: Map<string, MveLegList> } {
  const combos: KalshiMarketRow[] = [];
  const comboLegs = new Map<string, MveLegList>();
  const seen = new Set<string>();
  for (const raw of rawMarkets) {
    if (!isSportsParlayCandidate(raw, investing)) continue;
    const legs = parseMveSelectedLegs(raw);
    if (legs.length < 2) continue;
    const collection = mveCollectionTicker(raw) || "UNKNOWN";
    const mapped = mapKalshiMarketRaw(raw, {
      theme: "sports",
      related_symbol: null,
      category: encodeMveCategory(collection, legs),
      market_type: "multivariate",
    });
    if (!mapped || seen.has(mapped.market_ticker)) continue;
    seen.add(mapped.market_ticker);
    combos.push(mapped);
    comboLegs.set(mapped.market_ticker, legs);
  }
  const rankedAll = rankKalshiMarkets(combos);
  const ranked = cap == null ? rankedAll : rankedAll.slice(0, cap);
  const keep = new Set(ranked.map((row) => row.market_ticker));
  for (const key of [...comboLegs.keys()]) {
    if (!keep.has(key)) comboLegs.delete(key);
  }
  return { ranked, comboLegs };
}

/** Leg tickers for same-game two-leg stacks only — not n>2 or cross-game. */
export function executorSameGameLegTickers(
  comboLegs: Map<string, MveSelectedLeg[]>,
  comboTickers: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const spec of comboLegs.values()) {
    if (!isSameGameSportsTwoLeg(spec)) continue;
    for (const leg of spec) {
      const ticker = leg.market_ticker;
      if (!ticker || comboTickers.has(ticker) || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push(ticker);
    }
  }
  return out;
}

function mergeSportsCombos(
  primary: { ranked: KalshiMarketRow[]; comboLegs: Map<string, MveLegList> },
  extra: { ranked: KalshiMarketRow[]; comboLegs: Map<string, MveLegList> },
): { rows: KalshiMarketRow[]; comboLegs: Map<string, MveLegList> } {
  const byTicker = new Map(primary.ranked.map((row) => [row.market_ticker, row]));
  const comboLegs = new Map(primary.comboLegs);
  for (const row of extra.ranked) {
    if (byTicker.has(row.market_ticker)) continue;
    byTicker.set(row.market_ticker, row);
    const legs = extra.comboLegs.get(row.market_ticker);
    if (legs) comboLegs.set(row.market_ticker, legs);
  }
  return { rows: [...byTicker.values()], comboLegs };
}

function applySportsCandle(base: KalshiMarketRow, candle: unknown): KalshiMarketRow | null {
  const rec = asRecord(candle);
  if (!rec) return null;
  const endTs = Number(rec.end_period_ts);
  if (!Number.isFinite(endTs) || endTs <= 0) return null;
  const yesBid = candleCloseDollars(rec.yes_bid);
  const yesAsk = candleCloseDollars(rec.yes_ask);
  const price = asRecord(rec.price);
  const last = candleCloseDollars(rec.price)
    ?? parseKalshiNumber(price?.previous_dollars);
  if (yesBid == null && yesAsk == null && last == null) return null;
  if (looksLikeSettlementPrint(yesBid, yesAsk, last)) return null;
  const mid = yesBid != null && yesAsk != null ? (yesBid + yesAsk) / 2 : null;
  return {
    ...base,
    yes_bid: yesBid,
    yes_ask: yesAsk,
    yes_last: last ?? mid,
    no_bid: null,
    no_ask: null,
    volume: parseKalshiNumber(rec.volume_fp ?? rec.volume),
    volume_24h: null,
    open_interest: parseKalshiNumber(rec.open_interest_fp ?? rec.open_interest),
    fetched_at: new Date(endTs * 1000).toISOString(),
  };
}

async function fetchSportsCandles(
  env: KalshiEnv,
  bases: KalshiMarketRow[],
  startTs: number,
  endTs: number,
): Promise<KalshiMarketRow[]> {
  const byTicker = new Map(bases.map((row) => [row.market_ticker, row]));
  const tickers = [...byTicker.keys()];
  const out: KalshiMarketRow[] = [];
  const baseUrl = (env.KALSHI_API_BASE || DEFAULT_KALSHI_API_BASE).replace(/\/$/, "");
  for (let i = 0; i < tickers.length; i += KALSHI_CANDLE_TICKER_BATCH) {
    const batch = tickers.slice(i, i + KALSHI_CANDLE_TICKER_BATCH);
    const params = new URLSearchParams({
      market_tickers: batch.join(","),
      start_ts: String(startTs),
      end_ts: String(endTs),
      period_interval: String(KALSHI_CANDLE_INTERVAL_MIN),
    });
    const url = `${baseUrl}/markets/candlesticks?${params}`;
    let payload: unknown;
    try {
      payload = await fetchJson(url, env, `kalshi sports candles ${i}`);
    } catch {
      continue;
    }
    const markets = asRecord(payload)?.markets;
    if (!Array.isArray(markets)) continue;
    for (const item of markets) {
      const rec = asRecord(item);
      const ticker = strip(rec?.market_ticker).toUpperCase();
      const base = ticker ? byTicker.get(ticker) : undefined;
      const candles = rec?.candlesticks;
      if (!base || !Array.isArray(candles)) continue;
      for (const candle of candles) {
        const row = applySportsCandle(base, candle);
        if (row) out.push(row);
      }
    }
  }
  return out;
}

export interface KalshiSportsParlayPack {
  rows: KalshiMarketRow[];
  /** Selected legs from Get Markets `mve_selected_legs`, including event_ticker. */
  comboLegs: Map<string, MveSelectedLeg[]>;
}

/**
 * Sports parlays: MVE combo markets that name their legs, plus those leg
 * contracts. Open books are snapshotted live; settled/closed books in the
 * lookback window are daily candlesticks plus a tagged settlement 0/1
 * row (`source=kalshi_settlement`) so the backtest can grade fills
 * without mixing 0/1 into quote candles. Capped on combos (volume-first)
 * for the lake tape; every selected leg of those capped combos is kept.
 * Optional RFQ probe (KALSHI_RFQ_PROBE_ENABLED) fills same-game combo
 * bid/ask from solicited maker quotes, then cancels — never accepts.
 * The live executor does not use this pack — see
 * fetchKalshiParlayExecutorPack.
 *
 * Combo `category` keeps `event_ticker` as `yes:LEG@EVENT` so same-game
 * grouping works for MLB/WNBA props that lack an NFL-style date+teams
 * slug. Older `yes:LEG` rows still parse.
 */
export async function fetchKalshiSportsParlayPack(
  env: KalshiEnv = {},
): Promise<KalshiSportsParlayPack> {
  const meta = Object.values(KALSHI_SERIES).find((s) => s.ingest === "mve");
  const cap = meta ? maxMarketsFor(meta.series_ticker, env) : DEFAULT_MAX_MARKETS_PER_SERIES;
  const investing = investingKalshiSeries();
  const openPack = collectSportsCombos(await fetchMveRawMarkets(env, "open"), investing, cap);

  const lookbackDays = kalshiSportsLookbackDays(env);
  let histPack = { ranked: [] as KalshiMarketRow[], comboLegs: new Map<string, MveLegList>() };
  const nowMs = Date.now();
  const endTs = Math.floor(nowMs / 1000);
  const startTs = endTs - lookbackDays * 86400;
  if (lookbackDays > 0) {
    try {
      const lookbackMax = kalshiSportsLookbackMax(env);
      const extraSettled = `&min_settled_ts=${startTs}`;
      const extraClosed = `&min_close_ts=${startTs}`;
      const settledRaw = await fetchMveRawMarkets(env, "settled", extraSettled);
      const closedRaw = await fetchMveRawMarkets(env, "closed", extraClosed);
      histPack = collectSportsCombos([...settledRaw, ...closedRaw], investing, lookbackMax);
    } catch {
      histPack = { ranked: [], comboLegs: new Map() };
    }
  }

  const merged = mergeSportsCombos(openPack, histPack);
  const keep = new Set(merged.rows.map((row) => row.market_ticker));
  const legTickers: string[] = [];
  const seenLegs = new Set<string>();
  for (const row of merged.rows) {
    for (const leg of merged.comboLegs.get(row.market_ticker) ?? []) {
      if (keep.has(leg.market_ticker) || seenLegs.has(leg.market_ticker)) continue;
      seenLegs.add(leg.market_ticker);
      legTickers.push(leg.market_ticker);
    }
  }
  const legs = await fetchMarketsByTickers(legTickers, env);
  const bases = [...merged.rows, ...legs];
  const live = bases.filter((row) => !isKalshiSettledStatus(row.status));
  const openComboTickers = new Set(openPack.ranked.map((row) => row.market_ticker));
  const openCombos = live.filter((row) => openComboTickers.has(row.market_ticker));
  const probedCombos = await probeKalshiRfqQuotes(env, openCombos, openPack.comboLegs, legs);
  const probedByTicker = new Map(probedCombos.map((row) => [row.market_ticker, row]));
  const liveWithRfq = live.map((row) => probedByTicker.get(row.market_ticker) ?? row);
  if (lookbackDays <= 0) return { rows: liveWithRfq, comboLegs: merged.comboLegs };

  const candles = await fetchSportsCandles(env, bases, startTs, endTs);
  const settlements: KalshiMarketRow[] = [];
  for (const row of bases) {
    if (!isKalshiSettledStatus(row.status)) continue;
    const snap = asSettlementSnapshot(row);
    if (snap) settlements.push(snap);
  }
  return { rows: [...liveWithRfq, ...candles, ...settlements], comboLegs: merged.comboLegs };
}

/**
 * Live executor scan: every open sports MVE from Get Markets (no lake
 * volume-80 cap), plus selected-leg snapshots only for same-game two-leg
 * stacks. No candle backfill, no research RFQ overlay, not the full
 * sports catalog. RFQ ranking stays corr-room in pickRfqProbeTargets.
 */
export async function fetchKalshiParlayExecutorPack(
  env: KalshiEnv = {},
): Promise<KalshiSportsParlayPack> {
  const investing = investingKalshiSeries();
  const openPack = collectSportsCombos(await fetchMveRawMarkets(env, "open"), investing, null);
  const live = openPack.ranked.filter((row) => !isKalshiSettledStatus(row.status));
  const comboTickers = new Set(live.map((row) => row.market_ticker));
  const legs = await fetchMarketsByTickers(
    executorSameGameLegTickers(openPack.comboLegs, comboTickers),
    env,
  );
  return { rows: [...live, ...legs], comboLegs: openPack.comboLegs };
}

export async function fetchKalshiSportsParlays(
  env: KalshiEnv = {},
): Promise<KalshiMarketRow[]> {
  return (await fetchKalshiSportsParlayPack(env)).rows;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
export async function fetchKalshiSeriesMarkets(
  seriesId: string,
  env: KalshiEnv = {},
): Promise<KalshiMarketRow[]> {
  const meta = KALSHI_SERIES[seriesId];
  if (!meta) {
    throw new Error(`kalshi: unknown series_ticker ${seriesId}`);
  }
  if (meta.ingest === "mve") {
    return fetchKalshiSportsParlays(env);
  }
  const base = (env.KALSHI_API_BASE || DEFAULT_KALSHI_API_BASE).replace(/\/$/, "");
  const pageLimit = Math.min(
    1000,
    Math.max(1, Math.floor(num(env.KALSHI_PAGE_LIMIT, PAGE_LIMIT_DEFAULT))),
  );
  const maxPages = Math.max(1, Math.floor(num(env.KALSHI_MAX_PAGES, MAX_PAGES_DEFAULT)));

  // Skip Get Series (category enrichment) by default — each series costs an
  // extra public-API call and Kalshi 429s under the allowlist burst. Set
  // KALSHI_FETCH_SERIES_META=1 to re-enable.
  let seriesPayload: unknown = null;
  if (String(env.KALSHI_FETCH_SERIES_META || "") === "1") {
    try {
      seriesPayload = await fetchJson(
        `${base}/series/${encodeURIComponent(seriesId)}`,
        env,
        `kalshi series ${seriesId}`,
      );
    } catch {
      // Category enrichment is best-effort.
    }
  }

  const collected: KalshiMarketRow[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    let url =
      `${base}/markets?series_ticker=${encodeURIComponent(seriesId)}` +
      `&status=open&limit=${pageLimit}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const payload = await fetchJson(url, env, `kalshi markets ${seriesId} p${page}`);
    const batch = parseKalshiMarketsPayload(seriesId, payload);
    collected.push(...batch);
    const next = strip(asRecord(payload)?.cursor);
    if (!next || batch.length === 0) break;
    cursor = next;
  }

  const withCategory = applySeriesCategory(collected, seriesPayload);
  const ranked = rankKalshiMarkets(withCategory);
  const cap = maxMarketsFor(seriesId, env);
  return ranked.slice(0, cap);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------
export function normalizeKalshiRecords(
  rows: KalshiMarketRow[],
  runId: string,
  fetchedAt: string,
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const rec: Record<string, unknown> = {
      ...r,
      run_id: runId,
      fetched_at: r.fetched_at || fetchedAt,
    };
    const out: Record<string, unknown> = {};
    for (const f of KALSHI_MARKETS_FIELDS) out[f] = rec[f];
    return out;
  });
}

export async function publishKalshiSeries(
  seriesId: string,
  env: KalshiEnv = {},
): Promise<KalshiPublishResult> {
  const url = env.PIPELINE_KALSHI_MARKETS_URL || "";
  if (!url) throw new Error("kalshi publish requires PIPELINE_KALSHI_MARKETS_URL");
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = new Date(env.now ? env.now() : Date.now()).toISOString();
  const rows = await fetchKalshiSeriesMarkets(seriesId, env);
  if (rows.length === 0) {
    return {
      item: seriesId,
      row_count: 0,
      published: false,
      run_id: runId,
      fetched_at: fetchedAt,
    };
  }
  const records = normalizeKalshiRecords(rows, runId, fetchedAt);
  const maxBody = Math.floor(num(env.KALSHI_PIPELINE_MAX_BODY_BYTES, PIPELINE_MAX_BODY_BYTES_DEFAULT));
  const chunks = chunkKalshiPipelineRecords(records, maxBody);
  const auth = env.PIPELINE_AUTH_TOKEN || "";
  for (let i = 0; i < chunks.length; i++) {
    await requestJson(
      url,
      chunks[i],
      `kalshi:${runId}:${seriesId}:${i + 1}/${chunks.length}`,
      auth,
      env,
    );
  }
  return {
    item: seriesId,
    row_count: rows.length,
    published: true,
    run_id: runId,
    fetched_at: fetchedAt,
  };
}
