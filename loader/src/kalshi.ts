// Curated Kalshi event-contract snapshots for the options lake.
//
// Kalshi lists thousands of markets (sports, entertainment, politics). Lobster
// only wants investing-relevant series — Fed/rates, inflation, growth, equity
// indexes, crypto levels, oil, Treasuries — from symbols/kalshi-series.json.
// Each pass fetches open markets for one series_ticker, caps the set, and
// publishes to options.kalshi_markets via PIPELINE_KALSHI_MARKETS_URL.
//
// Public Trade API (no auth for market data):
//   https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=…&status=open
// Pure module (fetch / crypto only) so Vitest and the DO share one path.

import seriesManifest from "../symbols/kalshi-series.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Manifest / allowlist
// ---------------------------------------------------------------------------
export type KalshiTheme =
  | "rates"
  | "inflation"
  | "growth"
  | "equity_index"
  | "crypto"
  | "commodity";

export interface KalshiSeriesMeta {
  series_ticker: string;
  theme: KalshiTheme;
  title: string;
  related_symbol: string | null;
  max_markets?: number;
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

export const HTTP_RETRIES_DEFAULT = 5;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 20;
export const PAGE_LIMIT_DEFAULT = 200;
/** Cap pages — with limit=200 most series fit in 1–2 pages; fewer calls → fewer 429s. */
export const MAX_PAGES_DEFAULT = 3;
/** Floor gap between any two Kalshi GETs in this isolate (ms). */
export const MIN_REQUEST_GAP_MS_DEFAULT = 400;

export interface KalshiEnv {
  KALSHI_API_BASE?: string;
  /** Set to "1" to also fetch Get Series for category enrichment (extra API call). */
  KALSHI_FETCH_SERIES_META?: string;
  /**
   * Optional Kalshi API Key ID (UUID from Account → API Keys).
   * With KALSHI_PRIVATE_KEY_PEM, market GETs are RSA-PSS signed — higher rate
   * tiers than anonymous public GETs. Read-only keys are fine.
   */
  KALSHI_ACCESS_KEY_ID?: string;
  /**
   * Optional RSA private key PEM (PKCS#1 or PKCS#8). Wrangler secret only —
   * never commit. Pair with KALSHI_ACCESS_KEY_ID.
   */
  KALSHI_PRIVATE_KEY_PEM?: string;
  PIPELINE_KALSHI_MARKETS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  KALSHI_MAX_MARKETS?: number;
  KALSHI_PAGE_LIMIT?: number;
  KALSHI_MAX_PAGES?: number;
  /** Min ms between Kalshi GETs (default 400). */
  KALSHI_MIN_REQUEST_GAP_MS?: number;
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
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  // Kalshi often omits Retry-After; use a steeper floor for 429 than generic 5xx.
  if (status === 429) return Math.max(backoffSeconds(env, attempt), 8 * 2 ** attempt);
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
async function fetchJson(url: string, env: KalshiEnv, label: string): Promise<unknown> {
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const timeoutMs = Math.floor(num(env.REQUEST_TIMEOUT, REQUEST_TIMEOUT_SECONDS_DEFAULT) * 1000);
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
        try {
          const auth = await buildKalshiAuthHeaders("GET", url, env);
          if (auth) Object.assign(headers, auth);
        } catch (authError) {
          throw new Error(`kalshi auth sign failed: ${errMsg(authError)}`);
        }
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
        });
        if (response.ok) return await response.json();
        const code = response.status;
        const detail = await response.text();
        lastError = new Error(`${label} returned HTTP ${code}: ${detail.slice(0, 160)}`);
        // Retry 429 / 5xx; other 4xx fail immediately.
        if (code !== 429 && code < 500) throw lastError;
        if (attempt < retries) {
          const waitSec = retryWaitSeconds(env, attempt, code, response.headers.get("retry-after"));
          await sleep(waitSec * 1000);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /returned HTTP 4\d\d/.test(error.message) && !/returned HTTP 429/.test(error.message)) {
        throw error;
      }
      if (error instanceof Error && /kalshi auth sign failed/.test(error.message)) {
        throw error;
      }
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
    }
  }
  throw new Error(`${label} failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
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
    const m = asRecord(raw);
    if (!m) continue;
    const market_ticker = strip(m.ticker).toUpperCase();
    if (!market_ticker || seen.has(market_ticker)) continue;
    const title = strip(m.title) || market_ticker;
    const status = strip(m.status) || "unknown";
    seen.add(market_ticker);
    out.push({
      series_ticker: seriesId,
      market_ticker,
      event_ticker: strip(m.event_ticker) || null,
      title,
      yes_subtitle: strip(m.yes_sub_title) || strip(m.subtitle) || null,
      theme: meta.theme,
      category: null,
      status,
      market_type: strip(m.market_type) || null,
      yes_bid: parseKalshiNumber(m.yes_bid_dollars ?? m.yes_bid),
      yes_ask: parseKalshiNumber(m.yes_ask_dollars ?? m.yes_ask),
      yes_last: parseKalshiNumber(m.last_price_dollars ?? m.last_price),
      no_bid: parseKalshiNumber(m.no_bid_dollars ?? m.no_bid),
      no_ask: parseKalshiNumber(m.no_ask_dollars ?? m.no_ask),
      volume: parseKalshiNumber(m.volume_fp ?? m.volume),
      volume_24h: parseKalshiNumber(m.volume_24h_fp ?? m.volume_24h),
      open_interest: parseKalshiNumber(m.open_interest_fp ?? m.open_interest),
      liquidity: parseKalshiNumber(m.liquidity_dollars ?? m.liquidity),
      floor_strike: parseKalshiNumber(m.floor_strike),
      close_time: strip(m.close_time) || null,
      expiration_time: strip(m.expiration_time) || strip(m.expected_expiration_time) || null,
      related_symbol: meta.related_symbol,
      source: KALSHI_SOURCE,
    });
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

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
export async function fetchKalshiSeriesMarkets(
  seriesId: string,
  env: KalshiEnv = {},
): Promise<KalshiMarketRow[]> {
  if (!KALSHI_SERIES[seriesId]) {
    throw new Error(`kalshi: unknown series_ticker ${seriesId}`);
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
      fetched_at: fetchedAt,
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
  await requestJson(
    url,
    normalizeKalshiRecords(rows, runId, fetchedAt),
    `kalshi:${runId}:${seriesId}`,
    env.PIPELINE_AUTH_TOKEN || "",
    env,
  );
  return {
    item: seriesId,
    row_count: rows.length,
    published: true,
    run_id: runId,
    fetched_at: fetchedAt,
  };
}
