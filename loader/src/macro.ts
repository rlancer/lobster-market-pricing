// FRED inflation / price-index levels for the options lake.
//
// Sibling to yields.ts: curated CPI / core CPI / PCE / core PCE / PPI
// observations land in `options.macro` (not options.yields — that table stays
// the Treasury curve). Values are FRED published units — index levels for
// `units=index` rows and year-over-year percent for `units=yoy_pct` (fetched
// with FRED `units=pc1`). YoY series keep a stable lake series_id
// (`CPIAUCSL_YOY`, …) while still hitting the underlying FRED series id.
//
// Pure module (only depends on global fetch / crypto), mirroring yields.ts.

// ---------------------------------------------------------------------------
// Curated series allowlist
// ---------------------------------------------------------------------------
export type MacroKind = "cpi" | "pce" | "ppi";
export type MacroUnits = "index" | "yoy_pct";

export interface MacroSeriesMeta {
  title: string;
  kind: MacroKind;
  /** FRED observation units stored on the row. */
  units: MacroUnits;
  /** Monthly for all curated inflation prints. */
  frequency: "monthly";
  /**
   * Underlying FRED series id when the lake series_id is synthetic (YoY
   * transforms). Defaults to the allowlist key.
   */
  fred_series_id?: string;
  /** FRED observations `units` query param; default `lin` (index levels). */
  fred_units?: "lin" | "pc1";
}

export const MACRO_SERIES: Record<string, MacroSeriesMeta> = {
  CPIAUCSL: {
    title: "CPI All Urban Consumers: All Items (SA)",
    kind: "cpi",
    units: "index",
    frequency: "monthly",
  },
  CPILFESL: {
    title: "CPI All Urban Consumers: All Items Less Food and Energy (SA)",
    kind: "cpi",
    units: "index",
    frequency: "monthly",
  },
  CPIAUCSL_YOY: {
    title: "CPI All Items YoY %",
    kind: "cpi",
    units: "yoy_pct",
    frequency: "monthly",
    fred_series_id: "CPIAUCSL",
    fred_units: "pc1",
  },
  CPILFESL_YOY: {
    title: "Core CPI YoY %",
    kind: "cpi",
    units: "yoy_pct",
    frequency: "monthly",
    fred_series_id: "CPILFESL",
    fred_units: "pc1",
  },
  PCEPI: {
    title: "Personal Consumption Expenditures: Chain-type Price Index",
    kind: "pce",
    units: "index",
    frequency: "monthly",
  },
  PCEPILFE: {
    title: "PCE Excluding Food and Energy (Chain-type Price Index)",
    kind: "pce",
    units: "index",
    frequency: "monthly",
  },
  PCEPI_YOY: {
    title: "PCE Price Index YoY %",
    kind: "pce",
    units: "yoy_pct",
    frequency: "monthly",
    fred_series_id: "PCEPI",
    fred_units: "pc1",
  },
  PCEPILFE_YOY: {
    title: "Core PCE YoY %",
    kind: "pce",
    units: "yoy_pct",
    frequency: "monthly",
    fred_series_id: "PCEPILFE",
    fred_units: "pc1",
  },
  PPIFIS: {
    title: "Producer Price Index by Commodity: Final Demand",
    kind: "ppi",
    units: "index",
    frequency: "monthly",
  },
  PPIFIS_YOY: {
    title: "PPI Final Demand YoY %",
    kind: "ppi",
    units: "yoy_pct",
    frequency: "monthly",
    fred_series_id: "PPIFIS",
    fred_units: "pc1",
  },
};

export const FRED_SERIES_OBSERVATIONS_URL =
  "https://api.stlouisfed.org/fred/series/observations";

export const MACRO_SOURCE = "fred";

/** ~20y of monthly history — enough for multi-cycle inflation regime context. */
export const MACRO_LOOKBACK_DAYS = 7300;

export const MACRO_FIELDS = [
  "series_id",
  "date",
  "value",
  "title",
  "kind",
  "units",
  "frequency",
  "source",
  "run_id",
  "fetched_at",
] as const;

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 20;

export interface MacroEnv {
  FRED_API_KEY?: string;
  PIPELINE_MACRO_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  MACRO_LOOKBACK_DAYS?: number;
  now?: () => number;
  runId?: () => string;
}

export interface MacroRow {
  series_id: string;
  date: string; // YYYY-MM-DD
  value: number;
  title: string;
  kind: MacroKind;
  units: MacroUnits;
  frequency: "monthly";
  source: string;
}

export interface MacroPublishResult {
  item: string; // series_id
  row_count: number;
  published: boolean;
  run_id: string;
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Small shared helpers
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

function backoffSeconds(env: MacroEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

function isoDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fredSeriesId(seriesId: string, meta: MacroSeriesMeta): string {
  return meta.fred_series_id || seriesId;
}

function fredUnitsParam(meta: MacroSeriesMeta): "lin" | "pc1" {
  return meta.fred_units || "lin";
}

// ---------------------------------------------------------------------------
// Universe
// ---------------------------------------------------------------------------
/** One series_id per fetch+publish unit (isolation like fred-yields-daily). */
export function macroSeriesList(): string[] {
  return Object.keys(MACRO_SERIES);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function fetchJson(url: string, env: MacroEnv, label: string): Promise<unknown> {
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
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (response.ok) return await response.json();
        const code = response.status;
        const detail = await response.text();
        lastError = new Error(`${label} returned HTTP ${code}: ${detail.slice(0, 120)}`);
        if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
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
  env: MacroEnv,
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
// Fetch + parse
// ---------------------------------------------------------------------------
const FRED_DATE = /^\d{4}-\d{2}-\d{2}$/;

function lookbackDays(env: MacroEnv): number {
  return Math.max(1, Math.floor(num(env.MACRO_LOOKBACK_DAYS, MACRO_LOOKBACK_DAYS)));
}

function windowIso(env: MacroEnv): { start: string; end: string } {
  const now = env.now ? env.now() : Date.now();
  return {
    start: isoDate(now - lookbackDays(env) * 86400000),
    end: isoDate(now),
  };
}

/** Parse one FRED observations payload → MacroRow[] (skips missing "." values). */
export function parseFredMacroObservations(
  seriesId: string,
  payload: unknown,
): MacroRow[] {
  const meta = MACRO_SERIES[seriesId];
  if (!meta) throw new Error(`macro: unknown series_id ${seriesId}`);
  const data = asRecord(payload);
  const rows: MacroRow[] = [];
  for (const raw of Array.isArray(data?.observations) ? data.observations : []) {
    const o = asRecord(raw);
    const date = strip(o?.date);
    if (!FRED_DATE.test(date)) continue;
    const rawVal = strip(o?.value);
    if (!rawVal || rawVal === ".") continue;
    const value = Number(rawVal);
    if (!Number.isFinite(value)) continue;
    rows.push({
      series_id: seriesId,
      date,
      value,
      title: meta.title,
      kind: meta.kind,
      units: meta.units,
      frequency: meta.frequency,
      source: MACRO_SOURCE,
    });
  }
  return rows;
}

/** Fetch observations for one allowlisted series_id → MacroRow[]. */
export async function fetchMacroSeries(
  seriesId: string,
  env: MacroEnv,
): Promise<MacroRow[]> {
  const meta = MACRO_SERIES[seriesId];
  if (!meta) throw new Error(`macro: unknown series_id ${seriesId}`);
  const key = env.FRED_API_KEY;
  if (!key) throw new Error(`macro:${seriesId} requires FRED_API_KEY`);
  const { start, end } = windowIso(env);
  const fredId = fredSeriesId(seriesId, meta);
  const units = fredUnitsParam(meta);
  const url =
    `${FRED_SERIES_OBSERVATIONS_URL}?api_key=${encodeURIComponent(key)}&file_type=json` +
    `&series_id=${encodeURIComponent(fredId)}` +
    `&units=${encodeURIComponent(units)}` +
    `&observation_start=${start}&observation_end=${end}` +
    `&sort_order=asc`;
  const data = await fetchJson(url, env, `fred series ${seriesId}`);
  return parseFredMacroObservations(seriesId, data);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------
export async function publishMacroSeries(
  seriesId: string,
  env: MacroEnv = {},
): Promise<MacroPublishResult> {
  const url = env.PIPELINE_MACRO_URL || "";
  if (!url) throw new Error("macro publish requires PIPELINE_MACRO_URL");
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = new Date(env.now ? env.now() : Date.now()).toISOString();
  const rows = await fetchMacroSeries(seriesId, env);
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
    normalizeMacroRecords(rows, runId, fetchedAt),
    `macro:${runId}:${seriesId}`,
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

export function normalizeMacroRecords(
  rows: MacroRow[],
  runId: string,
  fetchedAt: string,
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const rec: Record<string, unknown> = {
      series_id: r.series_id,
      date: r.date,
      value: r.value,
      title: r.title,
      kind: r.kind,
      units: r.units,
      frequency: r.frequency,
      source: r.source,
      run_id: runId,
      fetched_at: fetchedAt,
    };
    const out: Record<string, unknown> = {};
    for (const f of MACRO_FIELDS) out[f] = rec[f];
    return out;
  });
}
