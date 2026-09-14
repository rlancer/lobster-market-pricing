/**
 * Admin proxy for the Kalshi same-game parlay RFQ executor.
 *
 * Loader GET /jobs/* is public on cboe-to-r2. This module pulls that JSON
 * through the screener Worker so the browser never talks to the loader, and
 * so last_pass.detail (would_accept / accepted) stays behind requireBotAdmin.
 *
 * POST trigger uses LOADER_TOKEN server-side only. This surface never sets
 * KALSHI_PARLAY_LIVE. Live size (contracts / max_accepts_per_pass) is read
 * from loader last_pass.detail.
 */

export const EXECUTOR_JOB_ID = "kalshi-parlay-executor";
export const HOURLY_JOB_ID = "kalshi-markets-hourly";
export const LOADER_BASE_DEFAULT = "https://cboe-to-r2.robertlancer.workers.dev";

const IDLE_REASONS = new Set(["execute_off", "no_api_keys", "no_targets", "forbidden"]);

export type ParlayIdleReason =
  | "execute_off"
  | "no_api_keys"
  | "no_targets"
  | "forbidden"
  | null;

export interface KalshiParlayAdminEnv {
  LOADER_BASE_URL?: string;
  LOADER_TOKEN?: string;
}

export interface KalshiParlayDecisionView {
  market_ticker: string;
  would_accept: boolean;
  accepted: boolean;
  reasons: string[];
  error: string | null;
  yes_bid: number | null;
  yes_ask: number | null;
  rfq_id: string | null;
  quote_id: string | null;
}

export interface KalshiParlaySampleView {
  market_ticker: string;
  n_legs: number;
  game_group: string;
  tape: string;
}

export interface KalshiParlayExecutorView {
  job_id: string;
  enabled: boolean;
  cadence_seconds: number;
  market_gated: boolean;
  next_attempt_after: number | null;
  last_success_at: number | null;
  consecutive_failures: number;
  last_error: string | null;
  last_pass_at: number | null;
  last_pass_duration_ms: number | null;
  /** Job-level last_pass.attempted (KXMVE universe size, usually 1). */
  pass_attempted: number | null;
  execute: boolean;
  live: boolean;
  idle_reason: ParlayIdleReason;
  open_combos: number;
  open_legs: number;
  combo_legs: number;
  two_leg: number;
  same_game_two_leg: number;
  cross_game_two_leg: number;
  missing_leg_mids: number;
  attempted: number;
  would_accept: number;
  accepted: number;
  skipped: number;
  contracts: number;
  max_accepts_per_pass: number;
  decisions: KalshiParlayDecisionView[];
  samples: KalshiParlaySampleView[];
}

export interface KalshiParlayHourlyView {
  job_id: string;
  enabled: boolean;
  last_success_at: number | null;
  last_pass_at: number | null;
  last_error: string | null;
  rfq_probe: string | null;
  live: boolean | null;
}

export interface KalshiParlayLoopView {
  passing: boolean;
  next_alarm: number | null;
}

export interface KalshiParlayMonitor {
  fetched_at: string;
  executor: KalshiParlayExecutorView;
  hourly: KalshiParlayHourlyView | null;
  loop: KalshiParlayLoopView | null;
  errors: { hourly: string | null; loop: string | null };
}

export interface KalshiParlayTriggerResult {
  ok: boolean;
  job: string;
  background?: boolean;
  note?: string;
  error?: string;
}

export type AdminGate =
  | { ok: true }
  | { ok: false; status: 401; error: string };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asBool(value: unknown, dflt = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return dflt;
}

function asInt(value: unknown, dflt = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

function asIntOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asNumOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asStr(value: unknown, dflt = ""): string {
  return typeof value === "string" ? value.trim() : dflt;
}

function asStrOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asIdleReason(value: unknown): ParlayIdleReason {
  if (value == null || value === "") return null;
  if (typeof value === "string" && IDLE_REASONS.has(value)) {
    return value as Exclude<ParlayIdleReason, null>;
  }
  return null;
}

export function loaderBaseUrl(env: KalshiParlayAdminEnv): string {
  return (env.LOADER_BASE_URL || LOADER_BASE_DEFAULT).replace(/\/+$/, "");
}

function unwrapJob(payload: unknown): Record<string, unknown> | null {
  const root = asRecord(payload);
  if (!root) return null;
  const job = asRecord(root.job);
  return job ?? (root.job_id != null ? root : null);
}

function lastPassOf(job: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(job.last_pass);
}

function detailOf(lastPass: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!lastPass) return null;
  const detail = asRecord(lastPass.detail);
  if (!detail) return null;
  if (detail.truncated === true) return null;
  return detail;
}

function mapDecision(raw: unknown): KalshiParlayDecisionView | null {
  const row = asRecord(raw);
  if (!row) return null;
  const market_ticker = asStr(row.market_ticker);
  if (!market_ticker) return null;
  const reasons = Array.isArray(row.reasons)
    ? row.reasons.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return {
    market_ticker,
    would_accept: asBool(row.would_accept),
    accepted: asBool(row.accepted),
    reasons,
    error: asStrOrNull(row.error),
    yes_bid: asNumOrNull(row.yes_bid),
    yes_ask: asNumOrNull(row.yes_ask),
    rfq_id: asStrOrNull(row.rfq_id),
    quote_id: asStrOrNull(row.quote_id),
  };
}

function mapSample(raw: unknown): KalshiParlaySampleView | null {
  const row = asRecord(raw);
  if (!row) return null;
  const market_ticker = asStr(row.market_ticker) || asStr(row.ticker);
  if (!market_ticker) return null;
  return {
    market_ticker,
    n_legs: asInt(row.n_legs),
    game_group: asStr(row.game_group, "unknown"),
    tape: asStr(row.tape, "none"),
  };
}

export function emptyExecutorView(): KalshiParlayExecutorView {
  return {
    job_id: EXECUTOR_JOB_ID,
    enabled: false,
    cadence_seconds: 0,
    market_gated: false,
    next_attempt_after: null,
    last_success_at: null,
    consecutive_failures: 0,
    last_error: null,
    last_pass_at: null,
    last_pass_duration_ms: null,
    pass_attempted: null,
    execute: false,
    live: false,
    idle_reason: "execute_off",
    open_combos: 0,
    open_legs: 0,
    combo_legs: 0,
    two_leg: 0,
    same_game_two_leg: 0,
    cross_game_two_leg: 0,
    missing_leg_mids: 0,
    attempted: 0,
    would_accept: 0,
    accepted: 0,
    skipped: 0,
    contracts: 10,
    max_accepts_per_pass: 1,
    decisions: [],
    samples: [],
  };
}

/** Shape loader GET /jobs/kalshi-parlay-executor into the admin monitor payload. */
export function shapeExecutorJob(payload: unknown): KalshiParlayExecutorView {
  const job = unwrapJob(payload);
  const base = emptyExecutorView();
  if (!job) return base;
  const lastPass = lastPassOf(job);
  const detail = detailOf(lastPass);
  const decisions = Array.isArray(detail?.decisions)
    ? detail.decisions.map(mapDecision).filter((row): row is KalshiParlayDecisionView => row != null).slice(0, 20)
    : [];
  const samples = Array.isArray(detail?.samples)
    ? detail.samples.map(mapSample).filter((row): row is KalshiParlaySampleView => row != null).slice(0, 5)
    : [];
  return {
    job_id: asStr(job.job_id, EXECUTOR_JOB_ID),
    enabled: asBool(job.enabled),
    cadence_seconds: asInt(job.cadence_seconds, 300),
    market_gated: asBool(job.market_gated),
    next_attempt_after: asIntOrNull(job.next_attempt_after),
    last_success_at: asIntOrNull(job.last_success_at),
    consecutive_failures: asInt(job.consecutive_failures),
    last_error: asStrOrNull(job.last_error),
    last_pass_at: asIntOrNull(lastPass?.at) ?? asIntOrNull(lastPass?.finished_at),
    last_pass_duration_ms: asIntOrNull(lastPass?.duration_ms),
    pass_attempted: asIntOrNull(lastPass?.attempted),
    execute: asBool(detail?.execute),
    live: asBool(detail?.live),
    idle_reason: asIdleReason(detail?.idle_reason),
    open_combos: asInt(detail?.open_combos),
    open_legs: asInt(detail?.open_legs),
    combo_legs: asInt(detail?.combo_legs),
    two_leg: asInt(detail?.two_leg),
    same_game_two_leg: asInt(detail?.same_game_two_leg),
    cross_game_two_leg: asInt(detail?.cross_game_two_leg),
    missing_leg_mids: asInt(detail?.missing_leg_mids),
    attempted: asInt(detail?.attempted),
    would_accept: asInt(detail?.would_accept),
    accepted: asInt(detail?.accepted),
    skipped: asInt(detail?.skipped),
    contracts: asInt(detail?.contracts, 10),
    max_accepts_per_pass: asInt(detail?.max_accepts_per_pass, 1),
    decisions,
    samples,
  };
}

export function shapeHourlyJob(payload: unknown): KalshiParlayHourlyView | null {
  const job = unwrapJob(payload);
  if (!job) return null;
  const lastPass = lastPassOf(job);
  const detail = detailOf(lastPass);
  return {
    job_id: asStr(job.job_id, HOURLY_JOB_ID),
    enabled: asBool(job.enabled),
    last_success_at: asIntOrNull(job.last_success_at),
    last_pass_at: asIntOrNull(lastPass?.at) ?? asIntOrNull(lastPass?.finished_at),
    last_error: asStrOrNull(job.last_error),
    rfq_probe: asStrOrNull(detail?.rfq_probe),
    live: detail && "live" in detail ? asBool(detail.live) : null,
  };
}

export function shapeLoopStatus(payload: unknown): KalshiParlayLoopView | null {
  const root = asRecord(payload);
  if (!root) return null;
  return {
    passing: asBool(root.passing),
    next_alarm: asIntOrNull(root.next_alarm),
  };
}

export function buildKalshiParlayMonitor(input: {
  executor: unknown;
  hourly: unknown;
  hourlyError?: string | null;
  loop: unknown;
  loopError?: string | null;
  nowMs?: number;
}): KalshiParlayMonitor {
  return {
    fetched_at: new Date(input.nowMs ?? Date.now()).toISOString(),
    executor: shapeExecutorJob(input.executor),
    hourly: input.hourlyError ? null : shapeHourlyJob(input.hourly),
    loop: input.loopError ? null : shapeLoopStatus(input.loop),
    errors: {
      hourly: input.hourlyError ?? null,
      loop: input.loopError ?? null,
    },
  };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 200) };
  }
}

export async function loaderGetJson(
  base: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(base + path, {
    method: "GET",
    headers: { "User-Agent": "screener-api/kalshi-parlay-admin" },
  });
  const body = await readJson(res);
  if (!res.ok) {
    const message = asStr(asRecord(body)?.error) || (typeof body === "string" ? body : `loader ${res.status}`);
    throw new Error(`loader ${res.status}: ${message.slice(0, 200)}`);
  }
  return { status: res.status, body };
}

export async function fetchKalshiParlayMonitor(
  env: KalshiParlayAdminEnv,
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<KalshiParlayMonitor> {
  const base = loaderBaseUrl(env);
  const executor = await loaderGetJson(base, `/jobs/${EXECUTOR_JOB_ID}`, fetchImpl);
  const executorRoot = asRecord(executor.body);
  if (executorRoot && executorRoot.ok === false) {
    throw new Error(asStr(executorRoot.error, `unknown job: ${EXECUTOR_JOB_ID}`));
  }

  const [hourlySettled, loopSettled] = await Promise.allSettled([
    loaderGetJson(base, `/jobs/${HOURLY_JOB_ID}`, fetchImpl),
    loaderGetJson(base, "/loop/status", fetchImpl),
  ]);

  const hourlyError = hourlySettled.status === "rejected"
    ? (hourlySettled.reason instanceof Error ? hourlySettled.reason.message : String(hourlySettled.reason))
    : null;
  const loopError = loopSettled.status === "rejected"
    ? (loopSettled.reason instanceof Error ? loopSettled.reason.message : String(loopSettled.reason))
    : null;

  return buildKalshiParlayMonitor({
    executor: executor.body,
    hourly: hourlySettled.status === "fulfilled" ? hourlySettled.value.body : null,
    hourlyError,
    loop: loopSettled.status === "fulfilled" ? loopSettled.value.body : null,
    loopError,
    nowMs,
  });
}

export async function triggerKalshiParlayPass(
  env: KalshiParlayAdminEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: KalshiParlayTriggerResult }> {
  const token = (env.LOADER_TOKEN || "").trim();
  if (!token) {
    return {
      status: 503,
      body: {
        ok: false,
        job: EXECUTOR_JOB_ID,
        error: "LOADER_TOKEN is not configured on the API Worker",
      },
    };
  }
  const base = loaderBaseUrl(env);
  const res = await fetchImpl(
    `${base}/jobs/${EXECUTOR_JOB_ID}/trigger?force=1&async=1`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "screener-api/kalshi-parlay-admin",
      },
    },
  );
  const raw = await readJson(res);
  const rec = asRecord(raw);
  if (res.status === 401 || res.status === 403) {
    return {
      status: 502,
      body: { ok: false, job: EXECUTOR_JOB_ID, error: "loader unauthorized" },
    };
  }
  return {
    status: res.status,
    body: {
      ok: rec?.ok === true,
      job: asStr(rec?.job, EXECUTOR_JOB_ID),
      background: rec?.background === true ? true : undefined,
      note: asStrOrNull(rec?.note) ?? undefined,
      error: asStrOrNull(rec?.error) ?? undefined,
    },
  };
}

export async function handleAdminKalshiParlay(
  env: KalshiParlayAdminEnv,
  req: Request,
  path: string,
  opts: {
    requireAdmin: (req: Request) => Promise<AdminGate>;
    fetchImpl?: typeof fetch;
  },
): Promise<Response | null> {
  const isStatus = path === "/api/admin/kalshi-parlay";
  const isTrigger = path === "/api/admin/kalshi-parlay/trigger";
  if (!isStatus && !isTrigger) return null;

  const admin = await opts.requireAdmin(req);
  if (!admin.ok) return json({ error: admin.error }, admin.status);

  const fetchImpl = opts.fetchImpl ?? fetch;

  if (isStatus) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    try {
      const body = await fetchKalshiParlayMonitor(env, fetchImpl);
      return json(body, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 502);
    }
  }

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const result = await triggerKalshiParlayPass(env, fetchImpl);
    return json(result.body, result.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message, ok: false, job: EXECUTOR_JOB_ID }, 502);
  }
}
