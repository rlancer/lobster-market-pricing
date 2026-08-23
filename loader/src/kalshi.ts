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

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 20;
export const PAGE_LIMIT_DEFAULT = 200;
export const MAX_PAGES_DEFAULT = 8;

export interface KalshiEnv {
  KALSHI_API_BASE?: string;
  PIPELINE_KALSHI_MARKETS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  KALSHI_MAX_MARKETS?: number;
  KALSHI_PAGE_LIMIT?: number;
  KALSHI_MAX_PAGES?: number;
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
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          headers: {
            accept: "application/json",
            "user-agent": "cboe-to-r2/0.2",
          },
          signal: controller.signal,
        });
        if (response.ok) return await response.json();
        const code = response.status;
        const detail = await response.text();
        lastError = new Error(`${label} returned HTTP ${code}: ${detail.slice(0, 160)}`);
        // Retry 429 / 5xx; other 4xx fail immediately.
        if (code !== 429 && code < 500) throw lastError;
        if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /returned HTTP 4\d\d/.test(error.message) && !/returned HTTP 429/.test(error.message)) {
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

  let seriesPayload: unknown = null;
  try {
    seriesPayload = await fetchJson(
      `${base}/series/${encodeURIComponent(seriesId)}`,
      env,
      `kalshi series ${seriesId}`,
    );
  } catch {
    // Category enrichment is best-effort; markets fetch is the hard requirement.
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
