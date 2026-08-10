// Macro / FOMC calendar enrichment path for the options lake.
//
// Tier-2 chat enrichment: fetch the
// scheduled high-impact macro releases (CPI, PPI, jobs, GDP, PCE, consumer
// sentiment) from FRED's release-date API plus FOMC/Beige Book events from the
// Federal Reserve's keyless calendar JSON, and publish normalized rows to
// `options.econ_calendar` via a Pipeline.
//
// Pure module (only depends on global fetch / crypto), mirroring the fetch +
// retry + Pipeline-publish style of earnings.ts so it can be published from
// the same Worker and is directly testable.
//
// Why these two sources:
//   - FRED `releases/dates` (plural) is NOT used: it ignores `release_id`,
//     emits DAILY placeholder dates for unscheduled press releases (FOMC), and
//     truncates at 1000 rows even for an 8-month window. Instead we call the
//     singular `/fred/release/dates` per allowlisted release_id with
//     `include_release_dates_with_no_data=true`, which returns the release's
//     REAL scheduled dates (historical + forward; CPI verified through 2026-12).
//   - FOMC/Beige dates + TIMES come from the Fed calendar JSON (2017-01 ..
//     2026-12, historical AND forward), which pre-schedules
//     meeting/press-conference dates and ET release times ("2:00 p.m." →
//     "14:00") accurately — FRED cannot provide them. FRED macro releases
//     have no release time in the API, so their event_time is null.

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
// FRED release_id → canonical release name for the curated high-impact macro
// allowlist. Exact same set the screener Worker's /api/econ_calendar matches
// (worker/src/index.ts ECON_FRED_RELEASES), so the lake and the endpoint agree.
export const ECON_FRED_RELEASES: Record<number, string> = {
  10: "Consumer Price Index",
  46: "Producer Price Index",
  50: "Employment Situation",
  53: "Gross Domestic Product",
  54: "Personal Income and Outlays",
  91: "Surveys of Consumers",
};

export const FRED_RELEASE_DATES_URL = "https://api.stlouisfed.org/fred/release/dates";
export const FED_CALENDAR_URL = "https://www.federalreserve.gov/json/calendar.json";

// Fed-calendar event types that move broad vol (the rest are weekly H-stat
// releases, speeches, and testimonies) — matches worker FED_CALENDAR_TYPES.
export const FED_CALENDAR_TYPES = new Set(["FOMC", "Beige"]);

// How many days of history and forward lookahead each sync window covers.
// ~2y back covers the lake's 1y of OHLC (realized FOMC-impact joins) with
// margin; the Fed calendar is pre-scheduled through year-end, so ~400d forward
// captures the full published schedule.
export const ECON_LOOKBACK_DAYS = 730;
export const ECON_FORWARD_DAYS = 400;

export const ECON_SOURCE_FRED = "fred";
export const ECON_SOURCE_FED = "federalreserve";

export const ECON_FIELDS = [
  "event_date", "title", "kind", "source", "event_time", "run_id", "fetched_at",
] as const;

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 20;

export interface EconEnv {
  FRED_API_KEY?: string;
  PIPELINE_ECON_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  now?: () => number; // epoch-ms seam for tests
  runId?: () => string; // stable run id for the whole pass
}

export interface EconRow {
  event_date: string; // YYYY-MM-DD
  title: string; // canonical display title
  kind: "macro" | "fed"; // macro = FRED release; fed = FOMC/Beige Book
  source: string; // ECON_SOURCE_FRED | ECON_SOURCE_FED
  event_time: string | null; // "HH:MM" ET (24h); null when the source has no time
}

export interface EconPublishResult {
  item: string; // source id, e.g. "fred:10" | "fed"
  row_count: number;
  published: boolean;
  run_id: string;
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Small shared helpers (local copies — same convention as earnings.ts)
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

function backoffSeconds(env: EconEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

// Canonical YYYY-MM-DD (UTC) for `ms` — the calendar is keyed by calendar date
// and UTC wall-clock is within an hour of ET from a nightly job's perspective.
function isoDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Source identity
// ---------------------------------------------------------------------------
// A "source id" addresses one fetch+publish unit so the daily job can isolate
// failures per source (exactly like earnings-daily isolates per date). The
// universe is the six allowlisted FRED releases plus the Fed calendar.
export function econSourceList(): string[] {
  return [
    ...Object.keys(ECON_FRED_RELEASES).map((id) => `fred:${id}`),
    ECON_SOURCE_FED,
  ];
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
// Canonical Fed-calendar title. Collapses data-entry variants (" FOMC Minutes",
// "FOMC meeting") onto one string so (event_date, title) dedupes cleanly.
function fedTitle(raw: unknown, type: string): string {
  const t = strip(raw);
  if (type === "FOMC") {
    if (/Meeting/i.test(t)) return "FOMC Meeting";
    if (/Press Conference/i.test(t)) return "FOMC Press Conference";
    if (/Minutes/i.test(t)) return "FOMC Minutes";
    return t || "FOMC";
  }
  if (type === "Beige") return "Beige Book";
  return t || type;
}

// Normalize Fed-calendar times ("2:00 p.m.", "8:30 a.m.") to "HH:MM" ET (24h).
// The Fed schedules in US Eastern wall-clock; null when unparseable/missing.
function normalizeEventTime(raw: unknown): string | null {
  const s = strip(raw);
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)$/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/p/i.test(m[3])) h += 12;
  const min = m[2];
  return `${String(h).padStart(2, "0")}:${min}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
// GET a JSON payload with bounded retry/backoff, mirroring fetchEarningsDate
// (retries all statuses up to HTTP_RETRIES, hard-fails only on transport
// exhaustion; a per-source failure is recorded by the job).
async function fetchJson(url: string, env: EconEnv, label: string): Promise<unknown> {
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
      else break;
    }
  }
  throw new Error(`${label} fetch failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

// POST a payload to a Pipeline ingest endpoint (5xx/network retries, 4xx
// hard-fail), mirroring earnings.ts requestJson. Idempotency per run × source.
async function requestJson(
  url: string,
  payload: unknown,
  idempotencyKey: string,
  authToken: string,
  env: EconEnv,
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
    if (code < 500) throw lastError; // non-retryable 4xx
    if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
  }
  throw new Error(
    `pipeline request failed after ${retries + 1} attempts: ${errMsg(lastError)}`,
  );
}

// ---------------------------------------------------------------------------
// Fetch one source
// ---------------------------------------------------------------------------
// Compute the sync window (start/end ISO) from env.now().
function windowIso(env: EconEnv): { start: string; end: string } {
  const now = env.now ? env.now() : Date.now();
  return {
    start: isoDate(now - ECON_LOOKBACK_DAYS * 86400000),
    end: isoDate(now + ECON_FORWARD_DAYS * 86400000),
  };
}

const FRED_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Fetch the scheduled release dates for one FRED release_id → EconRow[].
export async function fetchFredRelease(releaseId: number, env: EconEnv): Promise<EconRow[]> {
  const key = env.FRED_API_KEY;
  if (!key) throw new Error(`econ:fred:${releaseId} requires FRED_API_KEY`);
  const { start, end } = windowIso(env);
  const url =
    `${FRED_RELEASE_DATES_URL}?api_key=${encodeURIComponent(key)}&file_type=json` +
    `&release_id=${releaseId}&realtime_start=${start}&realtime_end=${end}` +
    `&include_release_dates_with_no_data=true&sort_order=asc&limit=1000`;
  const data = asRecord(await fetchJson(url, env, `fred release ${releaseId}`));
  const name = ECON_FRED_RELEASES[releaseId] ?? `Release ${releaseId}`;
  const rows: EconRow[] = [];
  for (const raw of Array.isArray(data?.release_dates) ? data.release_dates : []) {
    const r = asRecord(raw);
    const date = strip(r?.date);
    if (FRED_DATE.test(date)) {
      rows.push({ event_date: date, title: name, kind: "macro", source: ECON_SOURCE_FRED, event_time: null });
    }
  }
  return rows;
}

// Fetch FOMC (meetings/statements/minutes/press conferences) + Beige Book from
// the Fed's keyless calendar JSON → EconRow[]. Date = `month` + first `days`
// entry (recurring releases use a comma list); for "FOMC Meeting" that day is
// the decision day. The JSON carries history back to 2017, so past meetings
// are landed too, enabling realized FOMC-impact joins against options.ohlc.
export async function fetchFedCalendar(env: EconEnv): Promise<EconRow[]> {
  const data = asRecord(await fetchJson(FED_CALENDAR_URL, env, "federalreserve calendar"));
  const { start, end } = windowIso(env);
  const rows: EconRow[] = [];
  for (const raw of Array.isArray(data?.events) ? data.events : []) {
    const e = asRecord(raw);
    const type = strip(e?.type);
    if (!FED_CALENDAR_TYPES.has(type)) continue;
    const day = Number(strip(e?.days).split(",")[0].trim());
    if (!Number.isFinite(day) || day < 1 || day > 31) continue;
    const m = /^(\d{4})-(\d{2})$/.exec(strip(e?.month));
    if (!m) continue;
    const date = `${m[1]}-${m[2]}-${String(day).padStart(2, "0")}`;
    if (date < start || date > end) continue;
    rows.push({
      event_date: date,
      title: fedTitle(e?.title, type),
      kind: "fed",
      source: ECON_SOURCE_FED,
      event_time: normalizeEventTime(e?.time),
    });
  }
  return rows;
}

// Fetch + normalize + publish ONE source. Throws on a source failure (the job
// records it without aborting the rest of the pass).
export async function publishEconSource(
  source: string,
  env: EconEnv = {},
): Promise<EconPublishResult> {
  const url = env.PIPELINE_ECON_URL || "";
  if (!url) throw new Error("econ publish requires PIPELINE_ECON_URL");
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = new Date(env.now ? env.now() : Date.now()).toISOString();
  const rows = source === ECON_SOURCE_FED
    ? await fetchFedCalendar(env)
    : await fetchFredRelease(Number(source.slice("fred:".length)), env);
  if (rows.length === 0) {
    return { item: source, row_count: 0, published: false, run_id: runId, fetched_at: fetchedAt };
  }
  await requestJson(
    url,
    normalizeEconRecords(rows, runId, fetchedAt),
    `econ:${runId}:${source}`,
    env.PIPELINE_AUTH_TOKEN || "",
    env,
  );
  return { item: source, row_count: rows.length, published: true, run_id: runId, fetched_at: fetchedAt };
}

// Normalize (records exactly follow ECON_FIELDS order).
export function normalizeEconRecords(
  rows: EconRow[],
  runId: string,
  fetchedAt: string,
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const rec: Record<string, unknown> = {
      event_date: r.event_date, title: r.title, kind: r.kind, source: r.source,
      event_time: r.event_time, run_id: runId, fetched_at: fetchedAt,
    };
    const out: Record<string, unknown> = {};
    for (const f of ECON_FIELDS) out[f] = rec[f];
    return out;
  });
}