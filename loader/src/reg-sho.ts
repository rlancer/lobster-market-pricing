// FINRA Reg SHO daily short-sale volume → options.reg_sho_daily.
//
// Source: FINRA keyless POST API
//   https://api.finra.org/data/group/otcMarket/name/regShoDaily
// Partitioned by tradeReportDate. Each day is ~28k facility-level rows
// (NQTRF / NYTRF / NCTRF / ORF); we page at 5k, keep the effective universe,
// and roll facilities up to one row per (symbol, trade_date) with short_ratio
// = short_volume / total_volume. Weekends/holidays return HTTP 204.
//
// SIP share-class symbols use slashes (BRK/B); lake/manifest use dots (BRK.B).
// Published rows keep the lake symbol. Complements bi-monthly
// options.short_interest with a daily shorting-flow signal.

export const DEFAULT_REG_SHO_API_URL =
  "https://api.finra.org/data/group/otcMarket/name/regShoDaily";

export const REG_SHO_SOURCE = "finra";

export const REG_SHO_FIELDS = [
  "symbol",
  "trade_date",
  "short_volume",
  "short_exempt_volume",
  "total_volume",
  "short_ratio",
  "facility_count",
  "source",
  "run_id",
  "fetched_at",
] as const;

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 60;
export const REG_SHO_PAGE_SIZE_DEFAULT = 5000;
/** Calendar days of tradeReportDate candidates each pass covers (incl. today). */
export const REG_SHO_LOOKBACK_DAYS_DEFAULT = 14;

export interface RegShoEnv {
  REG_SHO_API_URL?: string;
  PIPELINE_REG_SHO_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  REG_SHO_PAGE_SIZE?: number;
  now?: () => number;
  runId?: () => string;
}

export interface RegShoRow {
  symbol: string;
  trade_date: string;
  short_volume: number;
  short_exempt_volume: number;
  total_volume: number;
  short_ratio: number | null;
  facility_count: number;
}

export interface RegShoPublishResult {
  trade_date: string;
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

function backoffSeconds(env: RegShoEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

function asFloat(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** YYYY-MM-DD from a UTC Date. */
export function isoDateUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Reg SHO SIP identifiers use `/` for share class (BRK.B → BRK/B, BF.B → BF/B).
 * Unlike consolidated short interest (undotted BRKB).
 */
export function regShoSipSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\./g, "/");
}

export function buildRegShoSymbolMaps(lakeSymbols: Iterable<string>): {
  lakeToSip: Map<string, string>;
  sipToLake: Map<string, string>;
} {
  const lakeToSip = new Map<string, string>();
  const sipToLake = new Map<string, string>();
  for (const raw of lakeSymbols) {
    const lake = raw.trim().toUpperCase();
    if (!lake) continue;
    const sip = regShoSipSymbol(lake);
    lakeToSip.set(lake, sip);
    if (!sipToLake.has(sip)) sipToLake.set(sip, lake);
  }
  return { lakeToSip, sipToLake };
}

/** Newest-first list of calendar dates: today back through lookbackDays-1. */
export function regShoTradeDateCandidates(
  nowMs: number,
  lookbackDays = REG_SHO_LOOKBACK_DAYS_DEFAULT,
): string[] {
  const n = Math.max(1, Math.floor(lookbackDays));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(isoDateUTC(new Date(nowMs - i * 86400000)));
  }
  return out;
}

export function shortRatio(shortVolume: number, totalVolume: number): number | null {
  if (!(totalVolume > 0) || !Number.isFinite(shortVolume) || !Number.isFinite(totalVolume)) {
    return null;
  }
  return shortVolume / totalVolume;
}

interface FacilityAccum {
  symbol: string;
  trade_date: string;
  short_volume: number;
  short_exempt_volume: number;
  total_volume: number;
  facility_count: number;
}

/** Fold one facility-level FINRA row into `acc` when the SIP symbol is in-universe. */
export function accumulateRegShoFacilityRow(
  raw: unknown,
  sipToLake: Map<string, string>,
  acc: Map<string, FacilityAccum>,
): void {
  const r = asRecord(raw);
  if (!r) return;
  const sip = strip(r.securitiesInformationProcessorSymbolIdentifier).toUpperCase();
  if (!sip) return;
  const symbol = sipToLake.get(sip);
  if (!symbol) return;
  const trade_date = strip(r.tradeReportDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trade_date)) return;
  const short_volume = asFloat(r.shortParQuantity) ?? 0;
  const short_exempt_volume = asFloat(r.shortExemptParQuantity) ?? 0;
  const total_volume = asFloat(r.totalParQuantity) ?? 0;
  const prev = acc.get(symbol);
  if (prev) {
    prev.short_volume += short_volume;
    prev.short_exempt_volume += short_exempt_volume;
    prev.total_volume += total_volume;
    prev.facility_count += 1;
    return;
  }
  acc.set(symbol, {
    symbol,
    trade_date,
    short_volume,
    short_exempt_volume,
    total_volume,
    facility_count: 1,
  });
}

export function finalizeRegShoAccum(acc: Map<string, FacilityAccum>): RegShoRow[] {
  const out: RegShoRow[] = [];
  for (const a of acc.values()) {
    out.push({
      symbol: a.symbol,
      trade_date: a.trade_date,
      short_volume: a.short_volume,
      short_exempt_volume: a.short_exempt_volume,
      total_volume: a.total_volume,
      short_ratio: shortRatio(a.short_volume, a.total_volume),
      facility_count: a.facility_count,
    });
  }
  return out;
}

/** Parse + roll up a FINRA JSON page into the accumulator. */
export function parseRegShoPageInto(
  payload: unknown,
  sipToLake: Map<string, string>,
  acc: Map<string, FacilityAccum>,
): void {
  if (!Array.isArray(payload)) return;
  for (const raw of payload) accumulateRegShoFacilityRow(raw, sipToLake, acc);
}

export function normalizeRegShoRecords(
  rows: RegShoRow[],
  source: string,
  runId: string,
  fetchedAt: string,
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const rec: Record<string, unknown> = {
      symbol: r.symbol,
      trade_date: r.trade_date,
      short_volume: r.short_volume,
      short_exempt_volume: r.short_exempt_volume,
      total_volume: r.total_volume,
      short_ratio: r.short_ratio,
      facility_count: r.facility_count,
      source,
      run_id: runId,
      fetched_at: fetchedAt,
    };
    const out: Record<string, unknown> = {};
    for (const f of REG_SHO_FIELDS) out[f] = rec[f];
    return out;
  });
}

async function requestJson(
  url: string,
  payload: unknown,
  idempotencyKey: string,
  authToken: string,
  env: RegShoEnv,
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
 * POST one Reg SHO page. Returns `null` on HTTP 204 (no trading day).
 * Retries 5xx/network; hard-fails other 4xx (except 429).
 */
export async function fetchRegShoPage(
  tradeDate: string,
  offset: number,
  limit: number,
  env: RegShoEnv = {},
): Promise<unknown[] | null> {
  const url = env.REG_SHO_API_URL || DEFAULT_REG_SHO_API_URL;
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const timeoutMs = Math.floor(num(env.REQUEST_TIMEOUT, REQUEST_TIMEOUT_SECONDS_DEFAULT) * 1000);
  const body = JSON.stringify({
    compareFilters: [
      { compareType: "EQUAL", fieldName: "tradeReportDate", fieldValue: tradeDate },
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
            throw new Error("finra reg sho returned non-array JSON");
          }
          return parsed;
        }
        const code = response.status;
        const detail = await response.text();
        lastError = new Error(
          `finra reg sho returned HTTP ${code}: ${detail.slice(0, 160)}`,
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
    `finra reg sho fetch failed after ${retries + 1} attempts: ${errMsg(lastError)}`,
  );
}

/** Page through one trade date; roll facilities up for `keepSymbols` (lake tickers). */
export async function fetchRegShoDate(
  tradeDate: string,
  keepSymbols: Set<string>,
  env: RegShoEnv = {},
): Promise<RegShoRow[]> {
  const pageSize = Math.max(
    1,
    Math.floor(num(env.REG_SHO_PAGE_SIZE, REG_SHO_PAGE_SIZE_DEFAULT)),
  );
  const { sipToLake } = buildRegShoSymbolMaps(keepSymbols);
  const acc = new Map<string, FacilityAccum>();
  let offset = 0;
  for (;;) {
    const page = await fetchRegShoPage(tradeDate, offset, pageSize, env);
    if (page == null) break;
    if (page.length === 0) break;
    parseRegShoPageInto(page, sipToLake, acc);
    if (page.length < pageSize) break;
    offset += pageSize;
    if (offset > 250_000) break;
  }
  return finalizeRegShoAccum(acc);
}

/**
 * Fetch + aggregate + publish ONE trade date. Empty / weekend dates return
 * `published: false`. Requires PIPELINE_REG_SHO_URL.
 */
export async function publishRegShoDate(
  tradeDate: string,
  env: RegShoEnv = {},
  keepSymbols?: Set<string>,
): Promise<RegShoPublishResult> {
  const url = env.PIPELINE_REG_SHO_URL || "";
  if (!url) {
    throw new Error("reg sho publish requires PIPELINE_REG_SHO_URL");
  }
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = new Date(env.now ? env.now() : Date.now()).toISOString();
  const keep = keepSymbols ?? new Set<string>();
  if (keep.size === 0) {
    return {
      trade_date: tradeDate,
      row_count: 0,
      published: false,
      run_id: runId,
      fetched_at: fetchedAt,
    };
  }
  const rows = await fetchRegShoDate(tradeDate, keep, env);
  if (rows.length === 0) {
    return {
      trade_date: tradeDate,
      row_count: 0,
      published: false,
      run_id: runId,
      fetched_at: fetchedAt,
    };
  }
  await requestJson(
    url,
    normalizeRegShoRecords(rows, REG_SHO_SOURCE, runId, fetchedAt),
    `reg_sho:${runId}:${tradeDate}`,
    env.PIPELINE_AUTH_TOKEN || "",
    env,
  );
  return {
    trade_date: tradeDate,
    row_count: rows.length,
    published: true,
    run_id: runId,
    fetched_at: fetchedAt,
  };
}
