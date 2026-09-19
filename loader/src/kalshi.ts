// Curated Kalshi event-contract snapshots for the options lake.
//
// Investing series (Fed/CPI/indexes/crypto/oil) come from symbols/kalshi-series.json
// as series_ticker GETs. Sports parlays are the KXMVE ingest: every open
// two-leg sports MVE (empty 0/0 CLOB included) plus the legs those combos
// select — not n>2 as the parlay universe, not the full sports catalog —
// and ~30 days of daily candlesticks (volume-capped) for those tickers.
// Settlement 0/1 is a separate source=kalshi_settlement row (not mixed into
// candles); two-leg / RFQ / fill tickers still settle when they miss the
// candle cap. Candle rows set fetched_at to the period end so latest-wins
// keeps quote history. Publishes to options.kalshi_markets via
// PIPELINE_KALSHI_MARKETS_URL.
//
// Public Trade API (no auth for market data):
//   https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=…&status=open
// Optional RFQ probe (KALSHI_RFQ_PROBE_ENABLED): POST /communications/rfqs on a
// capped same-game sports set, GET quotes, DELETE the RFQ — never accept.
// Pure module (fetch / crypto only) so Vitest and the DO share one path.

import seriesManifest from "../symbols/kalshi-series.json" with { type: "json" };
import {
  encodeMveCategory,
  isCrossGameSportsTwoLeg,
  isListedSportsTwoLeg,
  isSameGameSportsTwoLeg,
  isSportsParlayCandidate,
  mveCollectionTicker,
  parseMveCategory,
  parseMveSelectedLegs,
  seriesTickerFromMarketTicker,
  type MveSelectedLeg,
} from "./kalshi-mve.js";
import { parlayBook } from "./kalshi-parlay-filter.js";
import { probeKalshiRfqQuotes } from "./kalshi-rfq-quotes.js";
import {
  asSettlementSnapshot,
  inferComboSettlement,
  isKalshiSettledStatus,
  kalshiResultYes,
  looksLikeSettlementPrint,
  settlementYes,
  KALSHI_SETTLEMENT_SOURCE,
} from "./kalshi-settlement.js";

export {
  encodeMveCategory,
  parseMveCategory,
  parseMveSelectedLegs,
  parlayGameGroup,
  eventPrefixFromTicker,
  isListedSportsTwoLeg,
  isSameGameSportsTwoLeg,
  isCrossGameSportsTwoLeg,
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
/** MVE Get Markets pages per scan (default 12). Windowed scans — the executor
 *  candidate scan and the settled/closed lookbacks — stop here, at the head
 *  of Kalshi's default ordering. */
export const MVE_MAX_PAGES_DEFAULT = 12;
/** Open-MVE sweep pages per hourly pass (default 30, cap 60). Kalshi's open
 *  MVE catalog is 150k+ markets (n>2 CROSSCATEGORY auto-stacks), so a page-0
 *  window samples only ~2% of the two-leg sports universe. The hourly KXMVE
 *  fetch instead walks the whole catalog across passes, resuming from a
 *  D1-persisted cursor — full coverage every ceil(catalog / pages·limit)
 *  passes at a constant request budget. */
export const MVE_SWEEP_MAX_PAGES_DEFAULT = 30;
/** Sweep page size. 1000 is Kalshi's per-page maximum. */
export const MVE_SWEEP_PAGE_LIMIT_DEFAULT = 1000;
/** loader_meta key holding the open-MVE sweep continuation cursor. */
export const MVE_SWEEP_META_KEY = "kalshi_mve_sweep_cursor:open";
/** Floor gap between any two Kalshi GETs in this isolate (ms). */
export const MIN_REQUEST_GAP_MS_DEFAULT = 400;
/** Cap a single 429 sleep so one hot series cannot burn the whole pass budget. */
export const MAX_429_WAIT_SECONDS = 12;
/** Default sports-parlay candlestick lookback (days). */
export const KALSHI_SPORTS_LOOKBACK_DAYS_DEFAULT = 30;
/** Cap daily candles for settled/closed sports combos in that window.
 *  Two-leg settlement 0/1 rows are not volume-capped. */
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
  /** Whole-contract RFQ size (default 5, cap 10). $1 face → $5 notional. */
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
  /**
   * Executable book: same_game_underdog (code default, YES ask ≤ 50¢),
   * corr_room_yes (independence / φ gates), or cross_game_longshot
   * (YES ask ≤ 1/35 and ≤ independence).
   */
  KALSHI_PARLAY_BOOK?: string;
  /** Cumulative cash-debit cap in dollars for the spend run (default 100). */
  KALSHI_PARLAY_MAX_SPEND?: number | string;
  /** Spend-run id. Changing it stamps a new D1 started_at watermark. */
  KALSHI_PARLAY_SPEND_RUN_ID?: string;
  /** Optional ISO watermark; overrides D1 started_at when set. */
  KALSHI_PARLAY_SPEND_SINCE?: string;
  /** Loader D1 — sweep cursor, spend-run watermark, settlement queue. */
  LOADER_DB?: {
    prepare(query: string): {
      bind(...values: unknown[]): {
        first(): Promise<Record<string, unknown> | null>;
        all(): Promise<Array<Record<string, unknown>>>;
        run(): Promise<unknown>;
      };
    };
  };
  /** Max due tickers graded per hourly pass (default 2000, cap 10000). */
  KALSHI_SETTLEMENT_DRAIN_MAX?: number | string;
  /** Queue retention in days (default 45) — older entries are pruned. */
  KALSHI_SETTLEMENT_QUEUE_DAYS?: number | string;
  PIPELINE_KALSHI_MARKETS_URL?: string;
  /** Bearer token for pipeline stream POSTs. */
  PIPELINE_AUTH_TOKEN?: string;
  KALSHI_PIPELINE_MAX_BODY_BYTES?: number | string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  KALSHI_MAX_MARKETS?: number;
  KALSHI_PAGE_LIMIT?: number;
  KALSHI_MAX_PAGES?: number;
  /** Page cap for MVE Get Markets (default 12). Investing series keep KALSHI_MAX_PAGES. */
  KALSHI_MVE_MAX_PAGES?: number;
  /** Open-MVE sweep pages per hourly pass (default 30, cap 60). The hourly
   *  KXMVE fetch walks the whole open catalog across passes; windowed scans
   *  (executor, settled/closed lookback) still stop at KALSHI_MVE_MAX_PAGES. */
  KALSHI_MVE_SWEEP_MAX_PAGES?: number | string;
  /** Open-MVE sweep page size (default 1000 = Kalshi per-page max). */
  KALSHI_MVE_SWEEP_PAGE_LIMIT?: number | string;
  /** Min ms between Kalshi GETs (default 400). */
  KALSHI_MIN_REQUEST_GAP_MS?: number;
  /**
   * Sports-parlay history window in days (default 30). Daily candlesticks for
   * open + settled/closed MVE combos and their selected legs. 0 = open only.
   */
  KALSHI_SPORTS_LOOKBACK_DAYS?: number | string;
  /** Daily-candle cap on settled/closed sports combos (default 200). Settlements for
   *  two-leg / RFQ / fill tickers are not this cap. */
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
  /** Kalshi `result` (yes/no). Not a lake column — used to tag settlement 0/1. */
  result?: unknown;
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
    ...(m.result !== undefined ? { result: m.result } : {}),
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
  const raw = await fetchKalshiRawMarketsByTickers(tickers, env);
  return [...raw.values()]
    .map((item) => mapKalshiMarketRaw(item, { theme: "sports", related_symbol: null }))
    .filter((row): row is KalshiMarketRow => row != null);
}

/** Raw Get Markets records by ticker (map of ticker → raw payload). */
export async function fetchKalshiRawMarketsByTickers(
  tickers: string[],
  env: KalshiEnv,
): Promise<Map<string, unknown>> {
  const base = (env.KALSHI_API_BASE || DEFAULT_KALSHI_API_BASE).replace(/\/$/, "");
  const unique = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  const out = new Map<string, unknown>();
  const chunkSize = 20;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const url = `${base}/markets?tickers=${encodeURIComponent(chunk.join(","))}&limit=200`;
    const page = await fetchKalshiPage(url, env, `kalshi markets tickers ${i}`);
    for (const raw of page.markets) {
      const ticker = strip(asRecord(raw)?.ticker).toUpperCase();
      if (ticker) out.set(ticker, raw);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grade-on-close settlement queue
//
// The settled/closed Get Markets lookback scans are windowed at the 12x200
// alphabetical head, and sportsTapePinTickers only keeps pinned tickers that
// the window already fetched — so most tape tickers never got a
// source=kalshi_settlement row (measured 2026-09-18: 34 of 8,078 RFQ-quoted
// tickers graded; 73% of closed two-leg combos). The queue closes that hole:
// every listed two-leg combo on the hourly tape plus every RFQ / fill
// ticker is enqueued when first seen; once its close_time passes, a pass
// fetches it by ticker and publishes a settlement 0/1 row. Graded rows are
// deleted; entries older than KALSHI_SETTLEMENT_QUEUE_DAYS (default 45)
// are pruned so purged-from-API tickers cannot grow the queue forever.
// ---------------------------------------------------------------------------

export const SETTLEMENT_QUEUE_TABLE = "kalshi_settlement_queue";
export const SETTLEMENT_DRAIN_MAX_DEFAULT = 2000;
export const SETTLEMENT_QUEUE_DAYS_DEFAULT = 45;

/** Tape tickers that must eventually resolve: listed two-leg combos plus
 *  RFQ / fill pins (any leg count, matching sportsTapePinTickers). */
export function isSettlementQueueCandidate(row: KalshiMarketRow): boolean {
  const source = String(row.source ?? "").trim().toLowerCase();
  if (source === "kalshi_settlement") return false;
  if (source === "kalshi_rfq" || source === "kalshi_parlay_fill") return true;
  const parsed = parseMveCategory(row.category ?? null);
  return !!parsed && isListedSportsTwoLeg(parsed.legs);
}

export async function enqueueSettlementRows(
  env: KalshiEnv,
  rows: KalshiMarketRow[],
  nowMs = Date.now(),
): Promise<number> {
  const db = env.LOADER_DB ?? null;
  if (!db || rows.length === 0) return 0;
  const seen = new Set<string>();
  const pending: Array<[string, string]> = [];
  for (const row of rows) {
    const ticker = strip(row.market_ticker).toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    if (!isSettlementQueueCandidate(row)) continue;
    const closeTime = strip(row.close_time);
    if (!closeTime) continue;
    seen.add(ticker);
    pending.push([ticker, closeTime]);
  }
  if (pending.length === 0) return 0;
  try {
    for (let i = 0; i < pending.length; i += 100) {
      const values = pending.slice(i, i + 100);
      const tuples = values.map(() => "(?, ?, ?)").join(", ");
      await db.prepare(
        `INSERT OR IGNORE INTO ${SETTLEMENT_QUEUE_TABLE} (market_ticker, close_time, enqueued_at) VALUES ${tuples}`,
      ).bind(...values.flatMap(([ticker, closeTime]) => [ticker, closeTime, nowMs])).run();
    }
  } catch (error) {
    console.warn(`kalshi settlement queue: enqueue failed: ${errMsg(error)}`);
  }
  return pending.length;
}

/** Grade due tickers (close_time passed) by ticker lookup. Settled markets
 *  publish a 0/1 settlement row and leave the queue; still-trading or
 *  purged tickers stay queued for the next pass. Returns settlement rows to
 *  append to the pass's published batch. */
export async function drainSettlementQueue(
  env: KalshiEnv,
  nowMs = Date.now(),
): Promise<KalshiMarketRow[]> {
  const db = env.LOADER_DB ?? null;
  if (!db) return [];
  const dueIso = new Date(nowMs).toISOString();
  let due: Array<Record<string, unknown>> = [];
  try {
    due = await db.prepare(
      `SELECT market_ticker FROM ${SETTLEMENT_QUEUE_TABLE} WHERE close_time < ? ORDER BY close_time LIMIT ?`,
    ).bind(dueIso, envInt(env.KALSHI_SETTLEMENT_DRAIN_MAX, SETTLEMENT_DRAIN_MAX_DEFAULT, 1, 10000)).all();
    const pruneIso = new Date(nowMs - envInt(env.KALSHI_SETTLEMENT_QUEUE_DAYS, SETTLEMENT_QUEUE_DAYS_DEFAULT, 1, 365) * 86400000).toISOString();
    await db.prepare(`DELETE FROM ${SETTLEMENT_QUEUE_TABLE} WHERE close_time < ?`).bind(pruneIso).run();
  } catch (error) {
    console.warn(`kalshi settlement queue: drain select failed: ${errMsg(error)}`);
    return [];
  }
  const tickers = due.map((row) => strip(row.market_ticker).toUpperCase()).filter(Boolean);
  if (tickers.length === 0) return [];
  const out: KalshiMarketRow[] = [];
  const graded: string[] = [];
  for (let i = 0; i < tickers.length; i += 20) {
    const chunk = tickers.slice(i, i + 20);
    let rawByTicker: Map<string, unknown>;
    try {
      rawByTicker = await fetchKalshiRawMarketsByTickers(chunk, env);
    } catch (error) {
      console.warn(`kalshi settlement queue: grade chunk ${i} failed: ${errMsg(error)}`);
      continue;
    }
    for (const ticker of chunk) {
      const market = rawByTicker.get(ticker);
      if (!market) continue; // gone from the API for now — retry until pruned
      const mapped = mapKalshiMarketRaw(market, { theme: "sports", related_symbol: null });
      if (!mapped) {
        graded.push(ticker);
        continue;
      }
      if (!isKalshiSettledStatus(mapped.status)) continue; // still trading
      const snap = asSettlementSnapshot(mapped);
      if (snap) out.push(snap);
      graded.push(ticker);
    }
  }
  try {
    for (let i = 0; i < graded.length; i += 100) {
      const chunk = graded.slice(i, i + 100);
      const marks = chunk.map(() => "?").join(", ");
      await db.prepare(
        `DELETE FROM ${SETTLEMENT_QUEUE_TABLE} WHERE market_ticker IN (${marks})`,
      ).bind(...chunk).run();
    }
  } catch (error) {
    console.warn(`kalshi settlement queue: delete graded failed: ${errMsg(error)}`);
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

function kalshiMveMaxPages(env: KalshiEnv): number {
  return envInt(env.KALSHI_MVE_MAX_PAGES, MVE_MAX_PAGES_DEFAULT, 1, 30);
}

function kalshiMveSweepMaxPages(env: KalshiEnv): number {
  return envInt(env.KALSHI_MVE_SWEEP_MAX_PAGES, MVE_SWEEP_MAX_PAGES_DEFAULT, 1, 60);
}

function kalshiMveSweepPageLimit(env: KalshiEnv): number {
  return envInt(env.KALSHI_MVE_SWEEP_PAGE_LIMIT, MVE_SWEEP_PAGE_LIMIT_DEFAULT, 1, 1000);
}

function candleCloseDollars(raw: unknown): number | null {
  const rec = asRecord(raw);
  if (!rec) return parseKalshiNumber(raw);
  return parseKalshiNumber(rec.close_dollars ?? rec.close);
}

function loaderDb(env: KalshiEnv): NonNullable<KalshiEnv["LOADER_DB"]> | null {
  return env.LOADER_DB ?? null;
}

/** Continuation cursor for the open-MVE sweep, persisted in D1 loader_meta. */
async function loadMveSweepCursor(env: KalshiEnv): Promise<string> {
  const db = loaderDb(env);
  if (!db) return "";
  try {
    const row = await db.prepare("SELECT value FROM loader_meta WHERE key = ?")
      .bind(MVE_SWEEP_META_KEY).first();
    const raw = row && typeof row.value === "string" ? row.value : null;
    if (!raw) return "";
    const rec = asRecord(JSON.parse(raw));
    return strip(rec?.cursor);
  } catch {
    return "";
  }
}

async function saveMveSweepCursor(env: KalshiEnv, cursor: string): Promise<void> {
  const db = loaderDb(env);
  if (!db) return;
  try {
    await db.prepare(
      `INSERT INTO loader_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(MVE_SWEEP_META_KEY, JSON.stringify({ cursor }), Date.now()).run();
  } catch (error) {
    console.warn(`kalshi mve sweep: cursor save failed: ${errMsg(error)}`);
  }
}

async function clearMveSweepCursor(env: KalshiEnv): Promise<void> {
  const db = loaderDb(env);
  if (!db) return;
  try {
    await db.prepare("DELETE FROM loader_meta WHERE key = ?").bind(MVE_SWEEP_META_KEY).run();
  } catch (error) {
    console.warn(`kalshi mve sweep: cursor clear failed: ${errMsg(error)}`);
  }
}

/**
 * Get Markets with mve_filter=only, paged by cursor.
 *
 * Windowed mode (default): the first `maxPages` pages of Kalshi's default
 * ordering — the executor candidate scan and the settled/closed lookbacks
 * (whose min_*_ts query changes every pass, so cursor continuation there
 * would be meaningless).
 *
 * Sweep mode (status=open, hourly KXMVE tape): resume from the D1-persisted
 * cursor so each pass continues the catalog walk where the last one
 * stopped. Kalshi's open MVE catalog is 150k+ markets; the windowed head is
 * ~2% of it, biased by ticker hash. When the walk reaches the end of the
 * catalog the cursor row is cleared and the next pass restarts from the
 * top. A stale persisted cursor self-heals: the first page is retried from
 * the top of the catalog within the same pass. Sweep pages are filtered to
 * tape candidates as fetched (see isSweepTapeCandidate) — memory stays
 * page-bounded, and the cursor is saved per page so a mid-sweep eviction
 * resumes where it stopped.
 */

/** Sweep-streamed tapes keep only listed two-leg sports candidates. The
 *  tape drops everything else downstream (keepListedSportsUniverse); doing
 *  it per page keeps a 30×1000-market sweep inside the DO isolate's 128MB.
 *  Windowed scans (executor universe counts) still see n>2 stacks. */
function isSweepTapeCandidate(raw: unknown, investing: ReadonlySet<string>): boolean {
  if (!isSportsParlayCandidate(raw, investing)) return false;
  return isListedSportsTwoLeg(parseMveSelectedLegs(raw));
}

async function fetchMveRawMarkets(
  env: KalshiEnv,
  status: "open" | "settled" | "closed",
  extraQuery = "",
  opts: { sweep?: boolean } = {},
): Promise<unknown[]> {
  const base = (env.KALSHI_API_BASE || DEFAULT_KALSHI_API_BASE).replace(/\/$/, "");
  const sweep = opts.sweep === true;
  const pageLimit = sweep ? kalshiMveSweepPageLimit(env) : kalshiPageLimit(env);
  const maxPages = sweep ? kalshiMveSweepMaxPages(env) : kalshiMveMaxPages(env);
  const raw: unknown[] = [];
  let cursor = sweep ? await loadMveSweepCursor(env) : "";
  let resumed = cursor !== "";
  let page = 0;
  while (page < maxPages) {
    let url = `${base}/markets?mve_filter=only&status=${status}&limit=${pageLimit}${extraQuery}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    let batch: { markets: unknown[]; cursor: string };
    try {
      batch = await fetchKalshiPage(url, env, `kalshi mve ${status}${sweep ? " sweep" : ""} p${page}`);
    } catch (error) {
      if (!resumed) throw error;
      console.warn(`kalshi mve sweep: dropping stale cursor, restarting from page 0 (${errMsg(error)})`);
      resumed = false;
      cursor = "";
      continue;
    }
    resumed = false;
    // Sweep pages stream through the tape-candidate filter as fetched: the
    // open catalog is 150k+ markets and a Durable Object isolate caps at
    // 128MB — holding a full 30-page sweep of raw records (n>2 stack titles
    // run to kilobytes each) OOMs the alarm handler (2026-09-19 incident).
    // The windowed scans keep their full page (the executor counts n>2).
    raw.push(...(sweep
      ? batch.markets.filter((m) => isSweepTapeCandidate(m, investingKalshiSeries()))
      : batch.markets));
    if (!batch.cursor || batch.markets.length === 0) {
      cursor = "";
      break;
    }
    cursor = batch.cursor;
    // Persist per page so an OOM/cancel mid-sweep resumes where it stopped.
    if (sweep) await saveMveSweepCursor(env, cursor);
    page += 1;
  }
  if (sweep) {
    if (cursor) await saveMveSweepCursor(env, cursor);
    else await clearMveSweepCursor(env);
  }
  return raw;
}

/**
 * Sports MVE combos from Get Markets. Hourly lake ingest then keeps the
 * two-leg listed universe (no volume cap) via keepListedSportsUniverse.
 * The live executor passes null so n>2 counts stay in the scan.
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

export type SportsComboPack = {
  ranked: KalshiMarketRow[];
  comboLegs: Map<string, MveLegList>;
};

function filterSportsComboPack(
  pack: SportsComboPack,
  keep: ReadonlySet<string>,
): SportsComboPack {
  const ranked = pack.ranked.filter((row) => keep.has(row.market_ticker));
  const comboLegs = new Map<string, MveLegList>();
  for (const [ticker, legs] of pack.comboLegs) {
    if (keep.has(ticker)) comboLegs.set(ticker, legs);
  }
  return { ranked, comboLegs };
}

/**
 * Open sports tape: every two-leg sports MVE (volume 0 included).
 * Pin tickers (this pass's RFQ / fill) stay even if they are n>2.
 */
export function keepListedSportsUniverse(
  pack: SportsComboPack,
  pinTickers: ReadonlySet<string> = new Set(),
): SportsComboPack {
  const keep = new Set<string>();
  for (const row of pack.ranked) {
    const legs = pack.comboLegs.get(row.market_ticker) ?? [];
    if (pinTickers.has(row.market_ticker) || isListedSportsTwoLeg(legs)) {
      keep.add(row.market_ticker);
    }
  }
  return filterSportsComboPack(pack, keep);
}

/** Volume-rank and slice for daily candles only. Settlements use the unsliced pack. */
export function sliceSportsCandleUniverse(
  pack: SportsComboPack,
  cap: number,
): SportsComboPack {
  const ranked = rankKalshiMarkets(pack.ranked).slice(0, Math.max(0, Math.floor(cap)));
  return filterSportsComboPack(pack, new Set(ranked.map((row) => row.market_ticker)));
}

function sportsTapePinTickers(rows: KalshiMarketRow[]): Set<string> {
  const pin = new Set<string>();
  for (const row of rows) {
    const source = String(row.source || "").trim().toLowerCase();
    if (source === "kalshi_rfq" || source === "kalshi_parlay_fill") {
      pin.add(row.market_ticker);
    }
  }
  return pin;
}

function emitKalshiSettlementRows(
  combos: KalshiMarketRow[],
  comboLegs: Map<string, MveLegList>,
  legs: KalshiMarketRow[],
): KalshiMarketRow[] {
  const byTicker = new Map<string, KalshiMarketRow>();
  for (const row of [...legs, ...combos]) byTicker.set(row.market_ticker, row);
  const out: KalshiMarketRow[] = [];
  const seen = new Set<string>();
  const push = (row: KalshiMarketRow | null) => {
    if (!row) return;
    const key = `${row.market_ticker}|${row.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  };
  for (const row of [...combos, ...legs]) {
    if (!isKalshiSettledStatus(row.status)) continue;
    push(asSettlementSnapshot(row));
  }
  for (const combo of combos) {
    if (seen.has(`${combo.market_ticker}|${KALSHI_SETTLEMENT_SOURCE}`)) continue;
    const spec = comboLegs.get(combo.market_ticker) ?? [];
    const inferred = inferComboSettlement(spec.map((leg) => ({
      side: leg.side,
      settlement: settlementYes(byTicker.get(leg.market_ticker) ?? {}),
    })));
    if (inferred !== 0 && inferred !== 1) continue;
    push(asSettlementSnapshot({
      ...combo,
      status: "settled",
      yes_bid: inferred,
      yes_ask: inferred,
      yes_last: inferred,
      no_bid: 1 - inferred,
      no_ask: 1 - inferred,
      source: KALSHI_SOURCE,
    }));
  }
  return out;
}

/** Leg tickers for two-leg sports stacks the executor will score. */
export function executorTwoLegSportsTickers(
  comboLegs: Map<string, MveSelectedLeg[]>,
  comboTickers: ReadonlySet<string>,
  kind: "same_game" | "cross_game" | "both" = "same_game",
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const spec of comboLegs.values()) {
    const ok = kind === "both"
      ? isSameGameSportsTwoLeg(spec) || isCrossGameSportsTwoLeg(spec)
      : kind === "cross_game"
        ? isCrossGameSportsTwoLeg(spec)
        : isSameGameSportsTwoLeg(spec);
    if (!ok) continue;
    for (const leg of spec) {
      const ticker = leg.market_ticker;
      if (!ticker || comboTickers.has(ticker) || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push(ticker);
    }
  }
  return out;
}

/** Leg tickers for same-game two-leg stacks only — not n>2 or cross-game. */
export function executorSameGameLegTickers(
  comboLegs: Map<string, MveSelectedLeg[]>,
  comboTickers: ReadonlySet<string>,
): string[] {
  return executorTwoLegSportsTickers(comboLegs, comboTickers, "same_game");
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
 * contracts. Open two-leg sports books are snapshotted every pass (empty
 * 0/0 CLOB included — no KXMVE volume-80 cap). Settled/closed books in the
 * lookback window get daily candlesticks (volume-capped) plus a tagged
 * settlement 0/1 row (`source=kalshi_settlement`) so the backtest can grade
 * fills. Two-leg / RFQ / fill tickers always get a settlement row even when
 * they miss the candle volume cap. Never mix 0/1 into quote candles.
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
  const investing = investingKalshiSeries();
  const openAll = collectSportsCombos(
    await fetchMveRawMarkets(env, "open", "", { sweep: true }),
    investing,
    null,
  );
  const openPack = keepListedSportsUniverse(openAll);

  const lookbackDays = kalshiSportsLookbackDays(env);
  let histAll: SportsComboPack = { ranked: [], comboLegs: new Map() };
  const nowMs = Date.now();
  const endTs = Math.floor(nowMs / 1000);
  const startTs = endTs - lookbackDays * 86400;
  if (lookbackDays > 0) {
    try {
      const extraSettled = `&min_settled_ts=${startTs}`;
      const extraClosed = `&min_close_ts=${startTs}`;
      const settledRaw = await fetchMveRawMarkets(env, "settled", extraSettled);
      const closedRaw = await fetchMveRawMarkets(env, "closed", extraClosed);
      histAll = collectSportsCombos([...settledRaw, ...closedRaw], investing, null);
    } catch {
      histAll = { ranked: [], comboLegs: new Map() };
    }
  }

  const histListed = keepListedSportsUniverse(histAll);
  const histCandles = lookbackDays > 0
    ? sliceSportsCandleUniverse(histListed, kalshiSportsLookbackMax(env))
    : { ranked: [] as KalshiMarketRow[], comboLegs: new Map<string, MveLegList>() };

  const merged = mergeSportsCombos(openPack, histCandles);
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

  const pinTickers = sportsTapePinTickers(liveWithRfq);
  const settlementPack = keepListedSportsUniverse(histAll, pinTickers);
  const settlementCombos = settlementPack.ranked.filter((row) => isKalshiSettledStatus(row.status));
  const extraLegTickers: string[] = [];
  for (const combo of settlementCombos) {
    if (asSettlementSnapshot(combo)) continue;
    for (const leg of settlementPack.comboLegs.get(combo.market_ticker) ?? []) {
      if (keep.has(leg.market_ticker) || seenLegs.has(leg.market_ticker)) continue;
      seenLegs.add(leg.market_ticker);
      extraLegTickers.push(leg.market_ticker);
    }
  }
  const extraLegs = extraLegTickers.length
    ? await fetchMarketsByTickers(extraLegTickers, env)
    : [];
  const candles = await fetchSportsCandles(env, bases, startTs, endTs);
  const settlements = emitKalshiSettlementRows(
    settlementCombos,
    settlementPack.comboLegs,
    [...legs, ...extraLegs],
  );
  const comboLegs = new Map(merged.comboLegs);
  for (const [ticker, spec] of settlementPack.comboLegs) {
    if (!comboLegs.has(ticker)) comboLegs.set(ticker, spec);
  }
  return {
    rows: [...liveWithRfq, ...candles, ...settlements],
    comboLegs,
  };
}

/**
 * Live executor scan: every open sports MVE from Get Markets (including
 * n>2 counts; no volume cap), plus selected-leg snapshots for the active
 * book's two-leg sports stacks (same-game, or cross-game on the longshot
 * book). Hourly lake ingest now also persists every open two-leg sports
 * MVE. No candle backfill, no research RFQ overlay, not the full sports
 * catalog.
 */
export async function fetchKalshiParlayExecutorPack(
  env: KalshiEnv = {},
): Promise<KalshiSportsParlayPack> {
  const investing = investingKalshiSeries();
  const openPack = collectSportsCombos(await fetchMveRawMarkets(env, "open"), investing, null);
  const live = openPack.ranked.filter((row) => !isKalshiSettledStatus(row.status));
  const comboTickers = new Set(live.map((row) => row.market_ticker));
  const kind = parlayBook(env) === "cross_game_longshot" ? "cross_game" : "same_game";
  const legs = await fetchMarketsByTickers(
    executorTwoLegSportsTickers(openPack.comboLegs, comboTickers, kind),
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
  const maxPages = kalshiMaxPages(env);

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

/** Publish already-mapped kalshi_markets rows. No-ops without a pipeline URL. */
export async function publishKalshiMarketRows(
  rows: KalshiMarketRow[],
  env: KalshiEnv = {},
  label = "tape",
): Promise<KalshiPublishResult> {
  const url = env.PIPELINE_KALSHI_MARKETS_URL || "";
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = new Date(env.now ? env.now() : Date.now()).toISOString();
  if (!url || rows.length === 0) {
    return {
      item: label,
      row_count: rows.length,
      published: false,
      run_id: runId,
      fetched_at: fetchedAt,
    };
  }
  const records = normalizeKalshiRecords(rows, runId, fetchedAt);
  const maxBody = Math.floor(envNumber(env.KALSHI_PIPELINE_MAX_BODY_BYTES, PIPELINE_MAX_BODY_BYTES_DEFAULT));
  const chunks = chunkKalshiPipelineRecords(records, maxBody);
  const auth = env.PIPELINE_AUTH_TOKEN || "";
  for (let i = 0; i < chunks.length; i++) {
    await requestJson(
      url,
      chunks[i],
      `kalshi:${runId}:${label}:${i + 1}/${chunks.length}`,
      auth,
      env,
    );
  }
  return {
    item: label,
    row_count: rows.length,
    published: true,
    run_id: runId,
    fetched_at: fetchedAt,
  };
}

export async function publishKalshiSeries(
  seriesId: string,
  env: KalshiEnv = {},
): Promise<KalshiPublishResult> {
  const url = env.PIPELINE_KALSHI_MARKETS_URL || "";
  if (!url) throw new Error("kalshi publish requires PIPELINE_KALSHI_MARKETS_URL");
  const runId = env.runId?.() ?? crypto.randomUUID();
  const nowMs = env.now ? env.now() : Date.now();
  const fetchedAt = new Date(nowMs).toISOString();
  const rows = await fetchKalshiSeriesMarkets(seriesId, env);
  let publishedRows = rows;
  if (KALSHI_SERIES[seriesId]?.ingest === "mve") {
    // Grade-on-close: queue this pass's tape tickers, then resolve any whose
    // close_time has passed and append their settlement rows to the batch.
    // Drain runs even when the scan returned nothing — the backlog is
    // independent of this pass's fetch.
    if (rows.length) await enqueueSettlementRows(env, rows, nowMs);
    const settled = await drainSettlementQueue(env, nowMs);
    if (settled.length) publishedRows = [...rows, ...settled];
  }
  if (publishedRows.length === 0) {
    return {
      item: seriesId,
      row_count: 0,
      published: false,
      run_id: runId,
      fetched_at: fetchedAt,
    };
  }
  const records = normalizeKalshiRecords(publishedRows, runId, fetchedAt);
  const maxBody = Math.floor(envNumber(env.KALSHI_PIPELINE_MAX_BODY_BYTES, PIPELINE_MAX_BODY_BYTES_DEFAULT));
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
    row_count: publishedRows.length,
    published: true,
    run_id: runId,
    fetched_at: fetchedAt,
  };
}
