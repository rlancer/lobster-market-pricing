// FINRA consolidated equity short interest → options.short_interest.
//
// Source: FINRA keyless POST API
//   https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest
// Partition key is settlementDate (bi-monthly: mid-month ~15th and month-end,
// walked back for weekends/holidays). One settlement day is ~22k rows; we page
// at 5000 and keep only the effective universe. FINRA is redistributable
// (see root README licensing) — safe for /api/query.
//
// Share-class symbols: lake/manifest use exchange dots (BRK.B); FINRA uses
// undotted codes (BRKB). Published rows keep the lake symbol.

export const DEFAULT_SHORT_INTEREST_API_URL =
  "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest";

export const SHORT_INTEREST_SOURCE = "finra";

export const SHORT_INTEREST_FIELDS = [
  "symbol",
  "settlement_date",
  "short_interest",
  "prev_short_interest",
  "short_interest_change",
  "short_interest_change_pct",
  "avg_daily_volume",
  "days_to_cover",
  "market_class",
  "issue_name",
  "revision_flag",
  "stock_split_flag",
  "source",
  "run_id",
  "fetched_at",
] as const;

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 60;
export const SHORT_INTEREST_PAGE_SIZE_DEFAULT = 5000;
/** How many calendar months of mid/end settlement candidates each pass covers. */
export const SHORT_INTEREST_LOOKBACK_MONTHS_DEFAULT = 3;
/** Walk-back days from the 15th / month-end when probing holiday-shifted settlements. */
export const SHORT_INTEREST_SETTLEMENT_WALKBACK_DEFAULT = 4;

export interface ShortInterestEnv {
  SHORT_INTEREST_API_URL?: string;
  PIPELINE_SHORT_INTEREST_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  SHORT_INTEREST_PAGE_SIZE?: number;
  now?: () => number;
  runId?: () => string;
}

export interface ShortInterestRow {
  symbol: string;
  settlement_date: string;
  short_interest: number;
  prev_short_interest: number | null;
  short_interest_change: number | null;
  short_interest_change_pct: number | null;
  avg_daily_volume: number | null;
  days_to_cover: number | null;
  market_class: string | null;
  issue_name: string | null;
  revision_flag: string | null;
  stock_split_flag: string | null;
}

export interface ShortInterestPublishResult {
  settlement_date: string;
  row_count: number;
  published: boolean;
  run_id: string;
  fetched_at: string;
}

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

function backoffSeconds(env: ShortInterestEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

function asInt(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.replace(/,/g, ""));
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function asFloat(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asFlag(raw: unknown): string | null {
  const s = strip(raw);
  return s || null;
}

/** YYYY-MM-DD from a UTC Date. */
export function isoDateUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * FINRA symbol codes drop the share-class dot (BRK.B → BRKB, BF.B → BFB).
 * Slash forms (BRK/B) are also normalized the same way.
 */
export function finraSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[./]/g, "");
}

/**
 * Build lake-symbol → FINRA-code map, and the reverse for matching.
 * When two lake symbols collide on a FINRA code (shouldn't in our universe),
 * the first wins.
 */
export function buildFinraSymbolMaps(lakeSymbols: Iterable<string>): {
  lakeToFinra: Map<string, string>;
  finraToLake: Map<string, string>;
} {
  const lakeToFinra = new Map<string, string>();
  const finraToLake = new Map<string, string>();
  for (const raw of lakeSymbols) {
    const lake = raw.trim().toUpperCase();
    if (!lake) continue;
    const code = finraSymbol(lake);
    lakeToFinra.set(lake, code);
    if (!finraToLake.has(code)) finraToLake.set(code, lake);
  }
  return { lakeToFinra, finraToLake };
}

/**
 * Candidate settlement dates for the last `monthsBack` months: the 15th and
 * month-end of each month, plus walk-backs for weekends/holidays. Newest first,
 * deduped. The job treats HTTP 204 / empty pages as "not a settlement day"
 * (skip), so over-generating candidates is safe.
 */
export function shortInterestSettlementCandidates(
  nowMs: number,
  monthsBack = SHORT_INTEREST_LOOKBACK_MONTHS_DEFAULT,
  walkback = SHORT_INTEREST_SETTLEMENT_WALKBACK_DEFAULT,
): string[] {
  const months = Math.max(1, Math.floor(monthsBack));
  const walk = Math.max(0, Math.floor(walkback));
  const now = new Date(nowMs);
  const y0 = now.getUTCFullYear();
  const m0 = now.getUTCMonth(); // 0-based
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (d: Date) => {
    const iso = isoDateUTC(d);
    if (seen.has(iso)) return;
    seen.add(iso);
    out.push(iso);
  };
  for (let i = 0; i < months; i++) {
    let y = y0;
    let m = m0 - i;
    while (m < 0) {
      m += 12;
      y -= 1;
    }
    // Mid-month ~15th and walk-back.
    for (let off = 0; off <= walk; off++) {
      push(new Date(Date.UTC(y, m, 15 - off)));
    }
    // Month-end (day 0 of next month) and walk-back.
    const eom = new Date(Date.UTC(y, m + 1, 0));
    for (let off = 0; off <= walk; off++) {
      const d = new Date(eom);
      d.setUTCDate(eom.getUTCDate() - off);
      push(d);
    }
  }
  return out;
}

export function parseFinraShortInterestRow(
  raw: unknown,
  finraToLake: Map<string, string>,
): ShortInterestRow | null {
  const r = asRecord(raw);
  if (!r) return null;
  const code = strip(r.symbolCode).toUpperCase();
  if (!code) return null;
  const symbol = finraToLake.get(code);
  if (!symbol) return null;
  const settlement_date = strip(r.settlementDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settlement_date)) return null;
  const short_interest = asInt(r.currentShortPositionQuantity);
  if (short_interest == null) return null;
  return {
    symbol,
    settlement_date,
    short_interest,
    prev_short_interest: asInt(r.previousShortPositionQuantity),
    short_interest_change: asInt(r.changePreviousNumber),
    short_interest_change_pct: asFloat(r.changePercent),
    avg_daily_volume: asInt(r.averageDailyVolumeQuantity),
    days_to_cover: asFloat(r.daysToCoverQuantity),
    market_class: strip(r.marketClassCode) || null,
    issue_name: strip(r.issueName) || null,
    revision_flag: asFlag(r.revisionFlag),
    stock_split_flag: asFlag(r.stockSplitFlag),
  };
}

/** Parse a FINRA JSON page; keep only symbols present in `finraToLake`. */
export function parseFinraShortInterestPage(
  payload: unknown,
  finraToLake: Map<string, string>,
): ShortInterestRow[] {
  if (!Array.isArray(payload)) return [];
  const out: ShortInterestRow[] = [];
  const seen = new Set<string>();
  for (const raw of payload) {
    const row = parseFinraShortInterestRow(raw, finraToLake);
    if (!row) continue;
    if (seen.has(row.symbol)) continue;
    seen.add(row.symbol);
    out.push(row);
  }
  return out;
}

export function normalizeShortInterestRecords(
  rows: ShortInterestRow[],
  source: string,
  runId: string,
  fetchedAt: string,
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const rec: Record<string, unknown> = {
      symbol: r.symbol,
      settlement_date: r.settlement_date,
      short_interest: r.short_interest,
      prev_short_interest: r.prev_short_interest,
      short_interest_change: r.short_interest_change,
      short_interest_change_pct: r.short_interest_change_pct,
      avg_daily_volume: r.avg_daily_volume,
      days_to_cover: r.days_to_cover,
      market_class: r.market_class,
      issue_name: r.issue_name,
      revision_flag: r.revision_flag,
      stock_split_flag: r.stock_split_flag,
      source,
      run_id: runId,
      fetched_at: fetchedAt,
    };
    const out: Record<string, unknown> = {};
    for (const f of SHORT_INTEREST_FIELDS) out[f] = rec[f];
    return out;
  });
}

async function requestJson(
  url: string,
  payload: unknown,
  idempotencyKey: string,
  authToken: string,
  env: ShortInterestEnv,
): Promise<void> {
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const body = JSON.stringify(stripNones(payload));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "cboe-to-r2/0.2",
  };
  if (authToken) {
    headers["authorization"] = `Bearer ${authToken}`;
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
  throw new Error(
    `pipeline request failed after ${retries + 1} attempts: ${errMsg(lastError)}`,
  );
}

/**
 * POST one FINRA page. Returns `null` on HTTP 204 (no content for that
 * settlement date). Retries 5xx/network; hard-fails other 4xx.
 */
export async function fetchFinraShortInterestPage(
  settlementDate: string,
  offset: number,
  limit: number,
  env: ShortInterestEnv = {},
): Promise<unknown[] | null> {
  const url = env.SHORT_INTEREST_API_URL || DEFAULT_SHORT_INTEREST_API_URL;
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const timeoutMs = Math.floor(num(env.REQUEST_TIMEOUT, REQUEST_TIMEOUT_SECONDS_DEFAULT) * 1000);
  const body = JSON.stringify({
    compareFilters: [
      { compareType: "EQUAL", fieldName: "settlementDate", fieldValue: settlementDate },
    ],
    limit,
    offset,
  });
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let controller: AbortController | null = null;
    try {
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": "cboe-to-r2/0.2",
          },
          body,
          signal: controller.signal,
        });
        if (response.status === 204) return null;
        if (response.ok) {
          const text = await response.text();
          if (!text.trim()) return null;
          const parsed: unknown = JSON.parse(text);
          if (!Array.isArray(parsed)) {
            throw new Error("finra short interest returned non-array JSON");
          }
          return parsed;
        }
        const code = response.status;
        const detail = await response.text();
        lastError = new Error(
          `finra short interest returned HTTP ${code}: ${detail.slice(0, 160)}`,
        );
        if (code < 500 && code !== 429) throw lastError;
        if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      else break;
    }
  }
  throw new Error(
    `finra short interest fetch failed after ${retries + 1} attempts: ${errMsg(lastError)}`,
  );
}

/** Page through one settlement date; filter to `keepSymbols` (lake tickers). */
export async function fetchFinraShortInterestDate(
  settlementDate: string,
  keepSymbols: Set<string>,
  env: ShortInterestEnv = {},
): Promise<ShortInterestRow[]> {
  const pageSize = Math.max(
    1,
    Math.floor(num(env.SHORT_INTEREST_PAGE_SIZE, SHORT_INTEREST_PAGE_SIZE_DEFAULT)),
  );
  const { finraToLake } = buildFinraSymbolMaps(keepSymbols);
  const bySymbol = new Map<string, ShortInterestRow>();
  let offset = 0;
  for (;;) {
    const page = await fetchFinraShortInterestPage(settlementDate, offset, pageSize, env);
    if (page == null) {
      // 204 on the first page → not a settlement day; later pages shouldn't 204.
      break;
    }
    if (page.length === 0) break;
    for (const row of parseFinraShortInterestPage(page, finraToLake)) {
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row);
    }
    if (page.length < pageSize) break;
    offset += pageSize;
    // Safety cap (~50 pages × 5k = 250k) — consolidated SI is ~22k/day today.
    if (offset > 250_000) break;
  }
  return Array.from(bySymbol.values());
}

/**
 * Fetch + filter + publish ONE settlement date. Empty / unpublished dates
 * return `published: false` (not an error). Requires PIPELINE_SHORT_INTEREST_URL.
 */
export async function publishShortInterestDate(
  settlementDate: string,
  env: ShortInterestEnv = {},
  keepSymbols?: Set<string>,
): Promise<ShortInterestPublishResult> {
  const url = env.PIPELINE_SHORT_INTEREST_URL || "";
  if (!url) {
    throw new Error("short interest publish requires PIPELINE_SHORT_INTEREST_URL");
  }
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = new Date(env.now ? env.now() : Date.now()).toISOString();
  const keep = keepSymbols ?? new Set<string>();
  if (keep.size === 0) {
    return {
      settlement_date: settlementDate,
      row_count: 0,
      published: false,
      run_id: runId,
      fetched_at: fetchedAt,
    };
  }
  const rows = await fetchFinraShortInterestDate(settlementDate, keep, env);
  if (rows.length === 0) {
    return {
      settlement_date: settlementDate,
      row_count: 0,
      published: false,
      run_id: runId,
      fetched_at: fetchedAt,
    };
  }
  await requestJson(
    url,
    normalizeShortInterestRecords(rows, SHORT_INTEREST_SOURCE, runId, fetchedAt),
    `short_interest:${runId}:${settlementDate}`,
    env.PIPELINE_AUTH_TOKEN || "",
    env,
  );
  return {
    settlement_date: settlementDate,
    row_count: rows.length,
    published: true,
    run_id: runId,
    fetched_at: fetchedAt,
  };
}
