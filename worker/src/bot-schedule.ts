/**
 * Per-bot chat schedules — e.g. hourly market overview during US session.
 *
 * Cron on the API Worker wakes due rows; market-gated schedules skip while
 * closed and sleep until the next open. Scheduled prompts are fixed (repeat
 * allowed) unlike manual generate uniqueness.
 */
import { parseHandle } from "./profiles";
import { marketHoursEnabled, marketState, nextScheduleWakeMs, type MarketHoursEnv } from "./market-hours";

const PROMPT_MAX = 4_000;
const CADENCE_MIN = 300;
const CADENCE_MAX = 86_400;

export interface BotSchedule {
  handle: string;
  enabled: boolean;
  cadence_seconds: number;
  market_gated: boolean;
  prompt: string;
  next_run_at: number;
  last_run_at: number | null;
  last_run_id: string | null;
  consecutive_failures: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface BotScheduleInput {
  enabled?: unknown;
  cadence_seconds?: unknown;
  market_gated?: unknown;
  prompt?: unknown;
  next_run_at?: unknown;
}

type ScheduleRow = {
  handle: string;
  enabled: number;
  cadence_seconds: number;
  market_gated: number;
  prompt: string;
  next_run_at: number;
  last_run_at: number | null;
  last_run_id: string | null;
  consecutive_failures: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

function rowToSchedule(row: ScheduleRow): BotSchedule {
  return {
    handle: row.handle,
    enabled: row.enabled === 1,
    cadence_seconds: row.cadence_seconds,
    market_gated: row.market_gated === 1,
    prompt: row.prompt,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_run_id: row.last_run_id,
    consecutive_failures: row.consecutive_failures,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function validateBotScheduleInput(
  body: BotScheduleInput,
  existing?: BotSchedule | null,
): { ok: true; value: { enabled: boolean; cadence_seconds: number; market_gated: boolean; prompt: string; next_run_at: number | null } }
  | { ok: false; error: string } {
  const enabled = body.enabled === undefined
    ? (existing?.enabled ?? true)
    : !(body.enabled === false || body.enabled === 0 || body.enabled === "0" || body.enabled === "false");
  let cadence = existing?.cadence_seconds ?? 3600;
  if (body.cadence_seconds !== undefined && body.cadence_seconds !== null && body.cadence_seconds !== "") {
    const n = typeof body.cadence_seconds === "number" ? body.cadence_seconds : Number(body.cadence_seconds);
    if (!Number.isFinite(n) || n < CADENCE_MIN || n > CADENCE_MAX) {
      return { ok: false, error: `cadence_seconds must be ${CADENCE_MIN}–${CADENCE_MAX}` };
    }
    cadence = Math.floor(n);
  }
  const market_gated = body.market_gated === undefined
    ? (existing?.market_gated ?? true)
    : !(body.market_gated === false || body.market_gated === 0 || body.market_gated === "0" || body.market_gated === "false");
  let prompt = existing?.prompt ?? "";
  if (body.prompt !== undefined) {
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      return { ok: false, error: "prompt is required" };
    }
    prompt = body.prompt.trim().slice(0, PROMPT_MAX);
  }
  if (!prompt) return { ok: false, error: "prompt is required" };
  let next_run_at: number | null = null;
  if (body.next_run_at !== undefined && body.next_run_at !== null && body.next_run_at !== "") {
    const n = typeof body.next_run_at === "number" ? body.next_run_at : Number(body.next_run_at);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "next_run_at must be a non-negative epoch ms" };
    next_run_at = Math.floor(n);
  }
  return { ok: true, value: { enabled, cadence_seconds: cadence, market_gated, prompt, next_run_at } };
}

export async function getBotSchedule(db: D1Database, handle: string): Promise<BotSchedule | null> {
  const parsed = parseHandle(handle);
  if (!parsed.ok) return null;
  const row = await db.prepare("SELECT * FROM bot_schedules WHERE handle = ?1").bind(parsed.handle).first<ScheduleRow>();
  return row ? rowToSchedule(row) : null;
}

export async function upsertBotSchedule(
  db: D1Database,
  handleRaw: string,
  body: BotScheduleInput,
  env?: MarketHoursEnv,
): Promise<{ ok: true; schedule: BotSchedule } | { ok: false; status: 400 | 404; error: string }> {
  const parsed = parseHandle(handleRaw);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const bot = await db.prepare("SELECT handle FROM bot_profiles WHERE handle = ?1").bind(parsed.handle).first();
  if (!bot) return { ok: false, status: 404, error: "bot not found" };
  const existing = await getBotSchedule(db, parsed.handle);
  const validated = validateBotScheduleInput(body, existing);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  const now = Date.now();
  const next = validated.value.next_run_at
    ?? existing?.next_run_at
    ?? nextScheduleWakeMs(now, validated.value.cadence_seconds, {
      marketGated: validated.value.market_gated,
      env,
    });
  await db.prepare(
    `INSERT INTO bot_schedules
       (handle, enabled, cadence_seconds, market_gated, prompt, next_run_at, last_run_at, last_run_id,
        consecutive_failures, last_error, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
     ON CONFLICT(handle) DO UPDATE SET
       enabled = excluded.enabled,
       cadence_seconds = excluded.cadence_seconds,
       market_gated = excluded.market_gated,
       prompt = excluded.prompt,
       next_run_at = excluded.next_run_at,
       updated_at = excluded.updated_at`,
  ).bind(
    parsed.handle,
    validated.value.enabled ? 1 : 0,
    validated.value.cadence_seconds,
    validated.value.market_gated ? 1 : 0,
    validated.value.prompt,
    next,
    existing?.last_run_at ?? null,
    existing?.last_run_id ?? null,
    existing?.consecutive_failures ?? 0,
    existing?.last_error ?? null,
    now,
  ).run();
  const schedule = await getBotSchedule(db, parsed.handle);
  if (!schedule) return { ok: false, status: 400, error: "failed to save schedule" };
  return { ok: true, schedule };
}

export async function deleteBotSchedule(db: D1Database, handle: string): Promise<boolean> {
  const parsed = parseHandle(handle);
  if (!parsed.ok) return false;
  const result = await db.prepare("DELETE FROM bot_schedules WHERE handle = ?1").bind(parsed.handle).run();
  return (result.meta?.changes ?? 0) > 0;
}

/** Enabled schedules whose next_run_at is due (caller still applies market gate). */
export async function listDueBotSchedules(db: D1Database, nowMs = Date.now()): Promise<BotSchedule[]> {
  const rows = await db.prepare(
    `SELECT * FROM bot_schedules WHERE enabled = 1 AND next_run_at <= ?1 ORDER BY next_run_at ASC LIMIT 20`,
  ).bind(nowMs).all<ScheduleRow>();
  return (rows.results ?? []).map(rowToSchedule);
}

/**
 * Whether a due schedule should run now.
 * Market-gated + market closed → defer (not a failure).
 */
export function scheduleRunDecision(
  schedule: BotSchedule,
  nowMs: number,
  env?: MarketHoursEnv,
):
  | { action: "run" }
  | { action: "defer"; next_run_at: number; reason: string }
  | { action: "skip"; reason: string } {
  if (!schedule.enabled) return { action: "skip", reason: "disabled" };
  if (schedule.next_run_at > nowMs) return { action: "skip", reason: "not due" };
  if (schedule.market_gated && marketHoursEnabled(env)) {
    const st = marketState(nowMs, env);
    if (!st.open) {
      return {
        action: "defer",
        reason: st.reason,
        next_run_at: nextScheduleWakeMs(nowMs, schedule.cadence_seconds, {
          marketGated: true,
          env,
        }),
      };
    }
  }
  return { action: "run" };
}

export async function markScheduleSuccess(
  db: D1Database,
  handle: string,
  runId: string,
  nowMs: number,
  env?: MarketHoursEnv,
): Promise<BotSchedule | null> {
  const schedule = await getBotSchedule(db, handle);
  if (!schedule) return null;
  const next = nextScheduleWakeMs(nowMs, schedule.cadence_seconds, {
    marketGated: schedule.market_gated,
    env,
  });
  await db.prepare(
    `UPDATE bot_schedules SET
       last_run_at = ?2, last_run_id = ?3, next_run_at = ?4,
       consecutive_failures = 0, last_error = NULL, updated_at = ?2
     WHERE handle = ?1`,
  ).bind(handle, nowMs, runId, next).run();
  return getBotSchedule(db, handle);
}

export async function markScheduleFailure(
  db: D1Database,
  handle: string,
  error: string,
  nowMs: number,
  env?: MarketHoursEnv,
): Promise<BotSchedule | null> {
  const schedule = await getBotSchedule(db, handle);
  if (!schedule) return null;
  const failures = schedule.consecutive_failures + 1;
  const backoffMs = Math.min(
    schedule.cadence_seconds * 1000,
    Math.min(15 * 60_000 * failures, 60 * 60_000),
  );
  const next = schedule.market_gated && marketHoursEnabled(env) && !marketState(nowMs, env).open
    ? nextScheduleWakeMs(nowMs, schedule.cadence_seconds, { marketGated: true, env })
    : nowMs + backoffMs;
  await db.prepare(
    `UPDATE bot_schedules SET
       consecutive_failures = ?2, last_error = ?3, next_run_at = ?4, updated_at = ?5
     WHERE handle = ?1`,
  ).bind(handle, failures, error.slice(0, 2000), next, nowMs).run();
  return getBotSchedule(db, handle);
}

export async function deferSchedule(
  db: D1Database,
  handle: string,
  nextRunAt: number,
  nowMs: number,
): Promise<void> {
  await db.prepare(
    `UPDATE bot_schedules SET next_run_at = ?2, updated_at = ?3 WHERE handle = ?1`,
  ).bind(handle, nextRunAt, nowMs).run();
}

/** True when a queued/running run already exists for this bot (single-flight). */
export async function hasActiveBotRun(db: D1Database, handle: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS n FROM bot_runs WHERE handle = ?1 AND status IN ('queued', 'running') LIMIT 1`,
  ).bind(handle).first();
  return Boolean(row);
}
