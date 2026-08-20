// EtlScheduler — a generic ETL Durable Object alarm loop.
//
// Extracted from the bespoke CboeContinuousLoader (which was fused to CBOE /
// options / symbol_state / market-hours) into a job-agnostic scheduler that
// dispatches through a job registry. Each alarm pass:
//   1. ensures the `job_state` schedule ledger is seeded with the configured
//      jobs (INSERT OR IGNORE — idempotent),
//   2. due-scans `job_state` for enabled jobs whose next_attempt_after <= now
//      (ordered stalest-first), and for each due job runs its pass:
//        a. (item-scoped jobs) seeds its item store, picks the small batch of
//           due items, and applies per-item scheduling/backoff;
//        b. (batch-scoped jobs) runs the whole universe once per cadence.
// Registered jobs live in jobs/registry.ts (Phase 2: cboe-options + ohlc-daily).
//
// Single-flight: a DO processes one `alarm()` at a time and we only re-arm in
// the `finally`, so two passes can never overlap. A `passing` storage flag
// additionally guards any manual /loop/trigger against an in-flight pass.
//
// Market-hours gating is a per-job policy flag read from `job_state`
// (`market_gated`), not hard-wired loop logic. The alarm still sleeps until
// the next equity open when only gated work remains; due ungated jobs (Yahoo
// OHLC / crypto / …) pull the wake earlier so they are not stranded overnight.

import { buildJobs } from "./jobs/registry.js";

export const DRIVER_ID = "etl-scheduler-v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SchedulerEnv = Record<string, unknown>;

export interface SchedulerStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(value: number): Promise<void>;
}

export interface SchedulerCtx {
  storage: SchedulerStorage;
  waitUntil?(promise: Promise<unknown>): void;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first(): Promise<Record<string, unknown> | null>;
  all<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<{ success: boolean }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface JobRunFailure {
  symbol: string;
  error: string;
}

export interface JobRunResult {
  runId: string | null;
  failures: JobRunFailure[];
}

// A registered ETL job. Phase 2 registers two jobs via `jobs/registry.ts`
// (cboe-options + ohlc-daily); more are just additional registry entries.
//
// Two scopes, discriminated by `scope`:
//   - "items": item-scoped — the job maintains per-item scheduling/backoff in
//     its own item store (e.g. cboe-options → symbol_state). Each pass picks a
//     due batch, runs the handler, and applies per-item backoff.
//   - "batch": whole-universe — the job processes its full `universe()` each
//     pass and its frequency is governed by its job_state cadence (e.g.
//     ohlc-daily → all merged-universe symbols, once a day). No item store.
export interface JobBase {
  id: string;
  marketGated: boolean;
  cadenceSeconds: number;
  run(items: string[], env: SchedulerEnv): Promise<JobRunResult>;
}

export interface ItemJob extends JobBase {
  scope: "items";
  itemTable: string;
  itemIdColumn: string;
  seedItems(db: D1Database): Promise<void>;
  // Expected item-store row count after seeding. Lets the scheduler re-seed
  // additively when the universe grows (bundled manifest and/or on-demand
  // enrolled_symbols) without touching existing per-item progress. Legacy
  // jobs omit it → seed only when empty. May be async when it reads D1.
  seedSize?: (db: D1Database) => number | Promise<number>;
}

export interface BatchJob extends JobBase {
  scope: "batch";
  // May read D1 (enrolled_symbols ∪ bundled manifest). Scheduler always awaits.
  // `db` is optional so jobs that ignore enrollment (indexes/futures/econ) and
  // unit tests can keep calling `universe()` with no args.
  universe(db?: D1Database): string[] | Promise<string[]>;
}

export type JobSpec = ItemJob | BatchJob;

// One row of the `job_state` schedule ledger (see migrations/0002_job_state.sql).
export interface JobStateRow {
  job_id: string;
  handler: string;
  enabled: number;
  cadence_seconds: number;
  market_gated: number;
  next_attempt_after: number;
  last_success_at: number | null;
  consecutive_failures: number;
  backoff_seconds: number;
  last_error: string | null;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function num(env: SchedulerEnv | undefined, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// ---------------------------------------------------------------------------
// US market-hours gating
//
// The date/holiday helpers below are ported verbatim from the original driver
// (behavior unchanged). CBOE S&P 500 quotes only change during the regular US
// session; a job whose `market_gated` policy is set skips its pass while the
// market is closed. MARKET_HOURS_ENABLED="false" restores the always-on
// behavior globally.
// ---------------------------------------------------------------------------
const MIN = 60000;
const HOUR = 3600000;

function nthWeekdayDayOfMonth(year: number, month0: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

function lastWeekdayDayOfMonth(year: number, month0: number, weekday: number): number {
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month0, days)).getUTCDay();
  const offset = (last - weekday + 7) % 7;
  return days - offset;
}

// Gregorian Computus — Easter as a UTC-midnight epoch (ms).
function easterUtcMs(year: number): number {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month0 = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month0, day);
}

// Is `utcMs` inside US DST (America/New_York): 2nd Sun Mar 07:00 UTC →
// 1st Sun Nov 06:00 UTC.
function isUcDst(utcMs: number): boolean {
  const y = new Date(utcMs).getUTCFullYear();
  const start = Date.UTC(y, 2, nthWeekdayDayOfMonth(y, 2, 0, 2), 7);
  const end = Date.UTC(y, 10, nthWeekdayDayOfMonth(y, 10, 0, 1), 6);
  return utcMs >= start && utcMs < end;
}

// ET offset (hours behind UTC) at a given instant: 5 (EST) / 4 (EDT).
function etOffsetHours(utcMs: number): number {
  return isUcDst(utcMs) ? 4 : 5;
}

// ET wall-clock view of `utcMs` as a synthetic UTC Date whose calendar fields
// read as America/New_York local time.
function etWall(utcMs: number): Date {
  return new Date(utcMs - etOffsetHours(utcMs) * HOUR);
}

// Fully-closed US market holiday for an ET wall-clock date `w`.
function isHolidayClosed(w: Date): boolean {
  const y = w.getUTCFullYear();
  const mo = w.getUTCMonth(), d = w.getUTCDate();
  const on = (m0: number, day: number) => mo === m0 && d === day;
  const observed = (m0: number, day: number) => {
    const dy = new Date(Date.UTC(y, m0, day)).getUTCDay();
    if (dy === 0) return on(m0, day + 1); // Sun -> Mon
    if (dy === 6) return on(m0, day - 1); // Sat -> Fri
    return on(m0, day);
  };
  const gf = new Date(easterUtcMs(y) - 2 * 86400000);
  return (
    observed(0, 1) ||                                   // New Year's Day
    on(0, nthWeekdayDayOfMonth(y, 0, 1, 3)) ||          // MLK (3rd Mon Jan)
    on(1, nthWeekdayDayOfMonth(y, 1, 1, 3)) ||          // Presidents (3rd Mon Feb)
    on(gf.getUTCMonth(), gf.getUTCDate()) ||            // Good Friday
    on(4, lastWeekdayDayOfMonth(y, 4, 1)) ||            // Memorial (last Mon May)
    observed(5, 19) ||                                  // Juneteenth
    observed(6, 4) ||                                   // Independence Day
    on(8, nthWeekdayDayOfMonth(y, 8, 1, 1)) ||          // Labor (1st Mon Sep)
    on(10, nthWeekdayDayOfMonth(y, 10, 4, 4)) ||        // Thanksgiving (4th Thu Nov)
    observed(11, 25)                                    // Christmas
  );
}

// Early-close days (13:00 ET): Christmas Eve + the Friday after Thanksgiving.
function isEarlyClose(w: Date): boolean {
  const y = w.getUTCFullYear();
  const bf = new Date(Date.UTC(y, 10, nthWeekdayDayOfMonth(y, 10, 4, 4) + 1));
  return (
    (w.getUTCMonth() === 11 && w.getUTCDate() === 24) ||
    (w.getUTCMonth() === bf.getUTCMonth() && w.getUTCDate() === bf.getUTCDate())
  );
}

function marketHoursEnabled(env: SchedulerEnv | undefined): boolean {
  return (env && env.MARKET_HOURS_ENABLED) !== "false";
}

interface MarketState {
  open: boolean;
  reason: string;
  now_minutes: number;
  weekday: number;
  now_et: string;
  next_open: number | null;
}

function marketState(nowMs: number, env: SchedulerEnv | undefined): MarketState {
  const openMin = Math.floor(num(env, "MARKET_OPEN_MINUTES", 9 * 60 + 30));
  const closeMin = Math.floor(num(env, "MARKET_CLOSE_MINUTES", 16 * 60));
  const earlyMin = Math.floor(num(env, "MARKET_EARLY_CLOSE_MINUTES", 13 * 60));
  const w = etWall(nowMs);
  const weekday = w.getUTCDay();
  const minutes = w.getUTCHours() * 60 + w.getUTCMinutes();
  const base = { now_minutes: minutes, weekday, now_et: w.toISOString() };
  if (weekday === 0 || weekday === 6) {
    return { open: false, reason: "weekend", ...base, next_open: nextOpenMs(nowMs, env) };
  }
  if (isHolidayClosed(w)) {
    return { open: false, reason: "holiday", ...base, next_open: nextOpenMs(nowMs, env) };
  }
  const closeToday = isEarlyClose(w) ? earlyMin : closeMin;
  if (minutes >= openMin && minutes < closeToday) {
    return { open: true, reason: "open", ...base, next_open: null };
  }
  return {
    open: false,
    reason: minutes < openMin ? "overnight" : "after-hours",
    ...base,
    next_open: nextOpenMs(nowMs, env),
  };
}

// Epoch ms of the next US market open strictly after `nowMs`.
function nextOpenMs(nowMs: number, env: SchedulerEnv | undefined): number {
  const openMin = Math.floor(num(env, "MARKET_OPEN_MINUTES", 9 * 60 + 30));
  const w = etWall(nowMs);
  let y = w.getUTCFullYear(), mo = w.getUTCMonth(), d = w.getUTCDate();
  for (let i = 0; i < 16; i++) {
    const dow = new Date(Date.UTC(y, mo, d)).getUTCDay();
    const isTrading = dow !== 0 && dow !== 6 && !isHolidayClosed(new Date(Date.UTC(y, mo, d)));
    if (isTrading) {
      const dayUtc = Date.UTC(y, mo, d);
      const offH = etOffsetHours(dayUtc + openMin * MIN);
      const openMs = dayUtc + openMin * MIN + offH * HOUR;
      if (openMs > nowMs) return openMs;
    }
    const nd = new Date(Date.UTC(y, mo, d + 1));
    y = nd.getUTCFullYear(); mo = nd.getUTCMonth(); d = nd.getUTCDate();
  }
  return nowMs + 24 * HOUR;
}

// Market-hours wake only (ignores ungated job cadence). While the US session is
// open — or MARKET_HOURS_ENABLED=false — poll at LOADER_POLL_INTERVAL_SECONDS.
// While closed, sleep until the next open. Callers that also honor ungated
// Yahoo/crypto/daily jobs use EtlScheduler.computeNextWakeMs instead.
function marketNextWakeMs(env: SchedulerEnv | undefined, nowMs: number): number {
  const pollMs = Math.floor(num(env, "LOADER_POLL_INTERVAL_SECONDS", 60) * 1000);
  if (!marketHoursEnabled(env)) return nowMs + pollMs;
  const st = marketState(nowMs, env);
  return st.open ? nowMs + pollMs : (st.next_open != null ? st.next_open : nowMs + pollMs);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Safety net for a run that exceeds LOADER_RUN_TIMEOUT_SECONDS: surfaced as a
// transport error (the batch backs off and retries). The handler's per-request
// fetches already have their own timeout, so this only fires on pathological
// hangs; it cannot cancel in-flight publishes, but the pass is marked failed so
// the next tick re-picks the batch.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return promise;
  const { promise: raced, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(
    () => reject(new Error(`run timed out after ${ms}ms`)),
    ms,
  );
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
  return raced;
}

// ---------------------------------------------------------------------------
// EtlScheduler
// ---------------------------------------------------------------------------

export class EtlScheduler {
  protected ctx: SchedulerCtx;
  protected env: SchedulerEnv;
  jobs: JobSpec[];

  constructor(ctx: SchedulerCtx, env: SchedulerEnv, jobs: JobSpec[] = buildJobs(env)) {
    this.ctx = ctx;
    this.env = env;
    // Registered jobs come from the registry (jobs/registry.ts) by default;
    // tests may inject a custom spec set.
    this.jobs = jobs;
  }

  protected cboeItemJob(): ItemJob {
    const job = this.jobs.find((j) => j.id === "cboe-options");
    return (job && job.scope === "items" ? job : this.jobs[0]) as ItemJob;
  }

  protected db(): D1Database {
    return this.env.LOADER_DB as D1Database;
  }

  protected specFor(id: string): JobSpec | null {
    return this.jobs.find((j) => j.id === id) ?? null;
  }

  protected jobRowFromSpec(spec: JobSpec, now: number): JobStateRow {
    return {
      job_id: spec.id,
      handler: spec.id,
      enabled: 1,
      cadence_seconds: spec.cadenceSeconds,
      market_gated: spec.marketGated ? 1 : 0,
      next_attempt_after: 0,
      last_success_at: null,
      consecutive_failures: 0,
      backoff_seconds: Math.floor(num(this.env, "LOADER_BACKOFF_BASE_SECONDS", 60)),
      last_error: null,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Re-arm on EVERY request (idempotent: only arms when no alarm is set). A
    // DO reset/deploy consumes the in-flight alarm and, if it destroys the DO
    // mid-pass, the `finally` re-arm in alarm() never runs — leaving the loop
    // stranded. Re-arming here makes the loop self-healing.
    await this.ensureArmed();
    if (url.pathname === "/loop/trigger") {
      await this.tick();
      return json({ ok: true, note: "tick completed" });
    }
    if (url.pathname === "/loop/status") {
      return json(await this.status());
    }
    if (url.pathname === "/loop/symbols") {
      return json(await this.symbols(url));
    }
    // Job-aware observability + manual kick (/jobs, /jobs/{id},
    // /jobs/{id}/trigger). /loop/* above stay as cboe-options back-compat
    // aliases for the monitor. trigger auth is enforced at the Worker edge.
    if (url.pathname === "/jobs") {
      return json(await this.jobsList());
    }
    const jobMatch = /^\/jobs\/([^/]+)(\/trigger)?$/.exec(url.pathname);
    if (jobMatch) {
      const [, id, trigger] = jobMatch;
      if (trigger) {
        return this.triggerJob(id, url.searchParams.get("force") === "1");
      }
      return json(await this.jobStatus(id));
    }
    // Any other DO request (e.g. the worker's auto-arm ping): loop already
    // armed above.
    return json({ ok: true });
  }

  /**
   * Soonest `next_attempt_after` among enabled ungated jobs (market_gated=0).
   * Null when none exist. Ledger miss falls back to the registry: registered
   * ungated jobs seed as due-now (`next_attempt_after=0`).
   */
  protected async earliestUngatedAttemptMs(): Promise<number | null> {
    const row = await this.db()
      .prepare(
        `SELECT next_attempt_after FROM job_state
         WHERE enabled = 1 AND market_gated = 0
         ORDER BY next_attempt_after ASC
         LIMIT 1`,
      )
      .first();
    if (row && row.next_attempt_after != null) {
      return Number(row.next_attempt_after);
    }
    return this.jobs.some((j) => !j.marketGated) ? 0 : null;
  }

  /**
   * When the next alarm should fire.
   * - Market open (or MARKET_HOURS_ENABLED=false): poll cadence.
   * - Market closed: wake at the earlier of (a) next market open and (b) the
   *   soonest ungated job attempt. Already-due ungated jobs (Yahoo OHLC,
   *   spot crypto, futures, indexes, …) wake at poll cadence so they are not
   *   stuck until the equity session opens — that was stranding
   *   `crypto-spot-ohlc-daily` after an after-hours deploy.
   */
  async computeNextWakeMs(nowMs: number = Date.now()): Promise<number> {
    const pollMs = Math.floor(num(this.env, "LOADER_POLL_INTERVAL_SECONDS", 60) * 1000);
    const marketWake = marketNextWakeMs(this.env, nowMs);
    if (!marketHoursEnabled(this.env) || marketState(nowMs, this.env).open) {
      return marketWake;
    }
    const ungatedAt = await this.earliestUngatedAttemptMs();
    if (ungatedAt == null) return marketWake;
    const ungatedWake = ungatedAt <= nowMs ? nowMs + pollMs : ungatedAt;
    return Math.min(marketWake, ungatedWake);
  }

  // Re-arm to the earlier of the currently-armed alarm and the wake time implied
  // by the CURRENT market/config + ungated-job state. The min is the safe
  // direction: it never delays a pending pass-cycle but pulls the alarm EARLIER
  // when the market/config toggle changes or an ungated job becomes due.
  async ensureArmed(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    const target = await this.computeNextWakeMs(Date.now());
    const next = existing == null ? target : Math.min(existing, target);
    await this.ctx.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      // Never let a bad pass stop the loop. Log and re-arm.
      console.log(JSON.stringify({ event: "pass_error", error: String((error && (error as Error).message) || error) }));
    } finally {
      // Re-arm unconditionally so the loop is self-sustaining.
      await this.ctx.storage.setAlarm(await this.computeNextWakeMs(Date.now()));
    }
  }

  // Seed the `job_state` schedule ledger with the configured jobs. Idempotent:
  // INSERT OR IGNORE, so it is cheap to run on every pass and never clobbers
  // persisted progress or policy.
  async seedJobs(): Promise<void> {
    const base = Math.floor(num(this.env, "LOADER_BACKOFF_BASE_SECONDS", 60));
    for (const spec of this.jobs) {
      await this.db().prepare(
        `INSERT OR IGNORE INTO job_state
           (job_id, handler, enabled, cadence_seconds, market_gated,
            next_attempt_after, last_success_at, consecutive_failures,
            backoff_seconds, last_error)
         VALUES (?, ?, 1, ?, ?, 0, NULL, 0, ?, NULL)`
      ).bind(spec.id, spec.id, spec.cadenceSeconds, spec.marketGated ? 1 : 0, base).run();
    }
  }

  // Due-scan of the schedule ledger: enabled jobs whose next_attempt_after is
  // due, ordered stalest-first, limited to a batch. Returns the due job rows.
  //
  // Bootstrap fallback: if the ledger is empty (e.g. the 0002 migration has
  // not been applied/backfilled yet) the configured jobs are treated as due so
  // the loop self-bootstraps and seeds on the next pass rather than stalling.
  async dueJobs(now: number): Promise<JobStateRow[]> {
    const batch = Math.max(1, Math.floor(num(this.env, "JOB_BATCH_SIZE", 20)));
    const rows = await this.db().prepare(
      `SELECT job_id, handler, enabled, cadence_seconds, market_gated,
              next_attempt_after, last_success_at, consecutive_failures,
              backoff_seconds, last_error
       FROM job_state
       WHERE enabled = 1 AND next_attempt_after <= ?
       ORDER BY last_success_at ASC NULLS FIRST
       LIMIT ?`
    ).bind(now, batch).all();
    const list = rows.results as unknown as JobStateRow[];
    if (list.length === 0) {
      return this.jobs.map((spec) => this.jobRowFromSpec(spec, now));
    }
    return list;
  }

  // Seed an item-scoped job's item store. Seeds when the store is empty
  // (legacy jobs without `seedSize`) or smaller than the job's expected item
  // count, so a universe expansion (bundled ETFs / on-demand enrollment)
  // seeds its new items without touching existing per-item progress.
  // seedItems uses INSERT OR IGNORE, so a re-seed only adds missing rows.
  async seedIfEmpty(spec: ItemJob): Promise<boolean> {
    const db = this.db();
    const row = await db.prepare(
      `SELECT COUNT(*) AS c FROM ${spec.itemTable}`
    ).first();
    const expected = spec.seedSize ? await Promise.resolve(spec.seedSize(db)) : 1;
    if (row && (row.c as number) >= expected) return false;
    await spec.seedItems(db);
    return true;
  }

  // Pick the due items from a job's item store (stalest-first).
  async pickDue(batchSize: number, spec: ItemJob = this.cboeItemJob()): Promise<string[]> {
    const now = Date.now();
    const rows = await this.db().prepare(
      `SELECT ${spec.itemIdColumn} FROM ${spec.itemTable}
       WHERE enabled = 1 AND next_attempt_after <= ?
       ORDER BY priority ASC, last_success_at ASC NULLS FIRST
       LIMIT ?`
    ).bind(now, batchSize).all();
    return rows.results.map((r) => String(r[spec.itemIdColumn]));
  }

  // Record the attempt timestamp for the batch. D1 caps bind variables per
  // query (~100), so a large batch is chunked well under the limit.
  async markAttempts(symbols: string[], now: number, spec: ItemJob = this.cboeItemJob()): Promise<void> {
    const CHUNK_SIZE = 90;
    for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
      const chunk = symbols.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(",");
      await this.db().prepare(
        `UPDATE ${spec.itemTable} SET last_attempt_at = ? WHERE ${spec.itemIdColumn} IN (${placeholders})`
      ).bind(now, ...chunk).run();
    }
  }

  // Apply per-item pass results: success resets backoff and re-schedules at the
  // cadence; failure bumps consecutive_failures and walks the backoff tiers
  // (60s → 5m → 30m, then capped). Parameterized over the job's item store.
  async applyResults(
    batch: string[],
    successItems: string[],
    failMap: Map<string, string>,
    now: number,
    baseBackoff: number,
    capBackoff: number,
    cadence: number,
    transportError: string | null,
    spec: ItemJob = this.cboeItemJob(),
  ): Promise<void> {
    const db = this.db();
    const table = spec.itemTable;
    const idCol = spec.itemIdColumn;
    for (const item of successItems) {
      await db.prepare(
        `UPDATE ${table}
           SET last_success_at = ?, consecutive_failures = 0,
               backoff_seconds = ?, next_attempt_after = ?, last_error = NULL
         WHERE ${idCol} = ?`
      ).bind(now, baseBackoff, now + cadence * 1000, item).run();
    }
    for (const item of batch) {
      if (successItems.includes(item)) continue;
      const err = transportError
        ? `${transportError} (transport)`
        : (failMap.get(item) ?? "unknown");
      const row = await db
        .prepare(`SELECT consecutive_failures FROM ${table} WHERE ${idCol} = ?`)
        .bind(item)
        .first();
      const consecutive = (row && (row.consecutive_failures as number) ? (row.consecutive_failures as number) : 0) + 1;
      // Backoff tiers: 60s → 5m → 30m, then capped (×1, ×5, ×30 of the base).
      const tier = Math.min(consecutive - 1, 2);
      const mult = [1, 5, 30][tier]!;
      const backoff = Math.min(baseBackoff * mult, capBackoff);
      await db.prepare(
        `UPDATE ${table}
           SET consecutive_failures = ?, backoff_seconds = ?,
               next_attempt_after = ?, last_error = ?
         WHERE ${idCol} = ?`
      ).bind(consecutive, backoff, now + backoff * 1000, err, item).run();
    }
  }

  async storeMeta(key: string, value: unknown): Promise<void> {
    await this.db().prepare(
      `INSERT INTO loader_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, JSON.stringify(value), Date.now()).run();
  }

  // Reflect a completed job pass into its job_state ledger row. For a
  // continuous item-scoped job the row's next_attempt_after tracks the sweep
  // (poll) cadence — per-item scheduling stays in the item store — so the job
  // stays eligible at every wake and the sweep never stalls. Last-success /
  // failure counters are kept as a job-level ledger summary.
  async updateJobState(spec: JobSpec, row: JobStateRow, now: number, pass: { succeeded: number; transport_error: string | null }): Promise<void> {
    const base = Math.floor(num(this.env, "LOADER_BACKOFF_BASE_SECONDS", 60));
    if (pass.transport_error) {
      // Job-level backoff on a transport failure: escalate tiers (60s→5m→30m
      // capped), schedule the retry after the backoff.
      const consecutive = row.consecutive_failures + 1;
      const tier = Math.min(consecutive - 1, 2);
      const mult = [1, 5, 30][tier]!;
      const cap = Math.floor(num(this.env, "LOADER_BACKOFF_CAP_SECONDS", 1800));
      const backoff = Math.min(base * mult, cap);
      await this.db().prepare(
        `UPDATE job_state
           SET consecutive_failures = ?, backoff_seconds = ?,
               next_attempt_after = ?, last_error = ?
         WHERE job_id = ?`
      ).bind(consecutive, backoff, now + backoff * 1000, pass.transport_error, row.job_id).run();
      return;
    }
    // Success. Re-arm next_attempt_after:
    //   - batch job: after its cadence (e.g. ohlc-daily runs once a day);
    //   - item job: after the poll interval so it keeps sweeping the item
    //     store, re-picking symbols that become due between passes.
    const next = spec.scope === "batch"
      ? now + Math.max(1, row.cadence_seconds || spec.cadenceSeconds) * 1000
      : now + Math.floor(num(this.env, "LOADER_POLL_INTERVAL_SECONDS", 60) * 1000);
    await this.db().prepare(
      `UPDATE job_state
         SET last_success_at = ?, consecutive_failures = 0,
             backoff_seconds = ?, next_attempt_after = ?, last_error = NULL
       WHERE job_id = ?`
    ).bind(now, base, next, row.job_id).run();
  }

  protected runTimeoutMs(): number {
    return Math.max(
      1000,
      Math.floor(num(this.env, "LOADER_RUN_TIMEOUT_SECONDS", 300) * 1000),
    );
  }

  async tick(): Promise<void> {
    // Single-flight, with stale-flag self-healing (verbatim from the original).
    const runTimeoutMs = this.runTimeoutMs();
    const passing = await this.ctx.storage.get("passing");
    if (passing != null) {
      const stale = typeof passing !== "number" || Date.now() - (passing as number) >= runTimeoutMs + 60000;
      if (!stale) return; // another pass is in flight
      await this.ctx.storage.delete("passing");
    }
    await this.ctx.storage.put("passing", Date.now());
    try {
      await this.seedJobs();
      const now = Date.now();
      const due = await this.dueJobs(now);
      for (const row of due) {
        const spec = this.specFor(row.handler) ?? this.specFor(row.job_id);
        if (!spec) continue;
        await this.runJobPass(spec, row, runTimeoutMs);
      }
    } finally {
      await this.ctx.storage.delete("passing");
    }
  }

  // Run one job's pass: market gate (per-job policy), then dispatch by scope —
  // item jobs seed + pick a due batch + apply per-item backoff; batch jobs run
  // their whole universe and are governed by the job_state cadence.
  // `force` (explicit job trigger ?force=1) runs ONE pass outside market hours
  // without disabling the gate for the continuous loop — the safe "load the
  // closing data now" override. Never auto-set by the alarm loop.
  async runJobPass(spec: JobSpec, row: JobStateRow, runTimeoutMs: number, force = false): Promise<void> {
    // Per-job market-hours gate. MARKET_HOURS_ENABLED="false" disables it
    // globally (same switch the original driver used); `force` skips it for
    // this single pass only.
    if (!force && marketHoursEnabled(this.env) && row.market_gated === 1 && !marketState(Date.now(), this.env).open) {
      return;
    }
    const env = this.env;
    const baseBackoff = num(env, "LOADER_BACKOFF_BASE_SECONDS", 60);
    const capBackoff = num(env, "LOADER_BACKOFF_CAP_SECONDS", 1800);
    const cadence = (row.cadence_seconds || spec.cadenceSeconds);

    // Resolve the items this pass operates on.
    let batch: string[];
    if (spec.scope === "items") {
      const batchSize = Math.max(1, Math.floor(num(env, "LOADER_BATCH_SIZE", 10)));
      await this.seedIfEmpty(spec); // seed the item store on first run
      batch = await this.pickDue(batchSize, spec);
    } else {
      batch = await Promise.resolve(spec.universe(this.db()));
    }
    if (batch.length === 0) return; // nothing due this pass

    const now = Date.now();
    if (spec.scope === "items") {
      await this.markAttempts(batch, now, spec);
    }

    const started = Date.now();
    let failures: JobRunFailure[] = [];
    let runId: string | null = null;
    let transportError: string | null = null;
    try {
      const result = await withTimeout(spec.run(batch, env), runTimeoutMs);
      runId = result.runId;
      if (Array.isArray(result.failures)) failures = result.failures;
    } catch (error) {
      transportError = String((error && (error as Error).message) || error);
    }

    const failMap = new Map(failures.filter((f) => f.symbol).map((f) => [f.symbol, f.error]));
    // On a transport error the in-flight work was not awaited, so we cannot know
    // which items actually published. Do NOT mark the batch success: back the
    // whole batch off so the next pass re-picks it (publication is idempotent).
    const successItems = transportError
      ? []
      : batch.filter((s) => !failMap.has(s));

    if (spec.scope === "items") {
      await this.applyResults(
        batch, successItems, failMap, now,
        baseBackoff, capBackoff, cadence, transportError, spec,
      );
    }

    const pass = {
      at: now,
      finished_at: Date.now(),
      run_id: runId,
      attempted: batch.length,
      succeeded: successItems.length,
      failed: batch.length - successItems.length,
      batch,
      transport_error: transportError,
      duration_ms: Date.now() - started,
    };
    await this.storeMeta(`last_pass:${spec.id}`, pass);
    await this.updateJobState(spec, row, now, { succeeded: successItems.length, transport_error: transportError });
    console.log(JSON.stringify({
      event: "pass_completed",
      job: spec.id,
      attempted: pass.attempted,
      succeeded: pass.succeeded,
      failed: pass.failed,
      run_id: runId,
      error: transportError,
    }));
  }

  // ---------------------------------------------------------------------------
  // Job observability (/jobs, /jobs/{id}) + manual kick (/jobs/{id}/trigger)
  // ---------------------------------------------------------------------------

  async jobRows(): Promise<JobStateRow[]> {
    const rows = await this.db().prepare(
      `SELECT job_id, handler, enabled, cadence_seconds, market_gated,
              next_attempt_after, last_success_at, consecutive_failures,
              backoff_seconds, last_error
       FROM job_state
       ORDER BY job_id`
    ).all();
    return rows.results as unknown as JobStateRow[];
  }

  async jobRow(id: string): Promise<JobStateRow | null> {
    const row = await this.db().prepare(
      `SELECT job_id, handler, enabled, cadence_seconds, market_gated,
              next_attempt_after, last_success_at, consecutive_failures,
              backoff_seconds, last_error
       FROM job_state WHERE job_id = ?`
    ).bind(id).first();
    return (row as JobStateRow | null) ?? null;
  }

  protected async jobLastPass(id: string): Promise<Record<string, unknown> | null> {
    const row = await this.db()
      .prepare(`SELECT value FROM loader_meta WHERE key = ?`)
      .bind(`last_pass:${id}`)
      .first();
    if (!row || row.value == null) return null;
    try {
      return JSON.parse(String(row.value));
    } catch {
      return null;
    }
  }

  protected jobView(row: JobStateRow, now: number, scope: string | null, lastPass: Record<string, unknown> | null): Record<string, unknown> {
    return {
      job_id: row.job_id,
      handler: row.handler,
      scope,
      enabled: row.enabled,
      cadence_seconds: row.cadence_seconds,
      market_gated: row.market_gated,
      next_attempt_after: row.next_attempt_after,
      due: row.next_attempt_after <= now,
      last_success_at: row.last_success_at,
      consecutive_failures: row.consecutive_failures,
      backoff_seconds: row.backoff_seconds,
      last_error: row.last_error,
      last_pass: lastPass,
    };
  }

  async jobsList(): Promise<Record<string, unknown>> {
    await this.seedJobs(); // guarantee every registered job is present
    const now = Date.now();
    const jobs = await Promise.all(
      (await this.jobRows()).map(async (row) => {
        const spec = this.specFor(row.handler) ?? this.specFor(row.job_id);
        const scope = spec ? spec.scope : null;
        return this.jobView(row, now, scope, await this.jobLastPass(row.job_id));
      }),
    );
    return { ok: true, jobs };
  }

  async jobStatus(id: string): Promise<Record<string, unknown>> {
    const spec = this.specFor(id);
    if (!spec) return { ok: false, error: `unknown job: ${id}` };
    await this.seedJobs();
    const row = (await this.jobRow(id)) ?? this.jobRowFromSpec(spec, Date.now());
    return {
      ok: true,
      job: this.jobView(row, Date.now(), spec.scope, await this.jobLastPass(id)),
    };
  }

  // Manual kick: run a single job's pass now, regardless of its cadence/ledger
  // state, and reflect it. Auth is enforced at the Worker edge. `force` runs
  // the pass even when the market is closed (one-off "load the closing data"
  // override); the loop's own wake/sleep schedule is untouched afterwards.
  async triggerJob(id: string, force = false): Promise<Response> {
    const spec = this.specFor(id);
    if (!spec) return json({ error: `unknown job: ${id}` }, 404);
    await this.seedJobs();
    // Single-flight, same stale-marker self-healing as tick() (the loop must
    // never run two passes at once; a manual kick is a pass).
    const passing = await this.ctx.storage.get("passing");
    if (passing != null) {
      const stale = typeof passing !== "number" || Date.now() - (passing as number) >= this.runTimeoutMs() + 60000;
      if (!stale) return json({ ok: false, job: id, error: "pass already in flight" }, 409);
      await this.ctx.storage.delete("passing");
    }
    await this.ctx.storage.put("passing", Date.now());
    try {
      const row = (await this.jobRow(id)) ?? this.jobRowFromSpec(spec, Date.now());
      await this.runJobPass(spec, row, this.runTimeoutMs(), force);
    } finally {
      await this.ctx.storage.delete("passing");
    }
    return json({ ok: true, job: id, note: force ? "forced pass completed" : "pass completed" });
  }

  async status(): Promise<Record<string, unknown>> {
    const now = Date.now();
    const counts = await this.db().prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled,
         COALESCE(SUM(CASE WHEN enabled = 1 AND next_attempt_after <= ? THEN 1 ELSE 0 END), 0) AS due,
         COALESCE(SUM(CASE WHEN enabled = 1 AND consecutive_failures > 0 THEN 1 ELSE 0 END), 0) AS failing
       FROM symbol_state`
    ).bind(now).first();
    const lastPassRow = await this.db()
      .prepare(`SELECT value FROM loader_meta WHERE key = 'last_pass:cboe-options'`)
      .first();
    const m = marketState(now, this.env);
    return {
      ok: true,
      driver: "continuous",
      counts,
      last_pass: lastPassRow ? JSON.parse(String(lastPassRow.value)) : null,
      next_alarm: await this.ctx.storage.getAlarm(),
      passing: !!(await this.ctx.storage.get("passing")),
      market: {
        open: m.open,
        reason: m.reason,
        now_et: m.now_et,
        next_open_et: m.next_open != null ? new Date(m.next_open).toISOString() : null,
      },
    };
  }

  // Read-only per-symbol listing for the Loading Status monitor (unchanged from
  // the original driver). Never writes to D1.
  async symbols(url: URL): Promise<Record<string, unknown>> {
    const now = Date.now();
    const cadenceMs = Math.floor(num(this.env, "LOADER_CADENCE_SECONDS", 900) * 1000);

    const q = (url.searchParams.get("q") || "").trim();
    let filter = (url.searchParams.get("filter") || "all").toLowerCase();
    if (!["all", "failing", "due", "enabled", "disabled", "retrying", "stale"].includes(filter)) filter = "all";
    let sort = (url.searchParams.get("sort") || "symbol").toLowerCase();
    if (!["symbol", "last_success_at", "consecutive_failures"].includes(sort)) sort = "symbol";
    let order = (url.searchParams.get("order") || "asc").toLowerCase();
    if (order !== "desc") order = "asc";
    let limit = Math.floor(Number(url.searchParams.get("limit")));
    if (!Number.isFinite(limit)) limit = 100;
    limit = Math.max(1, Math.min(1000, limit));
    let offset = Math.floor(Number(url.searchParams.get("offset")));
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const clauses: string[] = [];
    const params: unknown[] = [];
    switch (filter) {
      case "enabled": clauses.push("enabled = 1"); break;
      case "disabled": clauses.push("enabled = 0"); break;
      case "failing": clauses.push("enabled = 1 AND consecutive_failures > 0"); break;
      case "retrying": clauses.push("consecutive_failures > 0"); break;
      case "due":
        clauses.push("enabled = 1 AND next_attempt_after <= ?");
        params.push(now);
        break;
      case "stale":
        clauses.push(
          "enabled = 1 AND consecutive_failures = 0 AND " +
          "(last_success_at IS NULL OR last_success_at < ?)"
        );
        params.push(now - cadenceMs);
        break;
    }
    if (q) {
      clauses.push("symbol LIKE ?");
      params.push(`%${q.toUpperCase()}%`);
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";

    const countRow = await this.db()
      .prepare(`SELECT COUNT(*) AS c FROM symbol_state ${where}`)
      .bind(...params)
      .first();
    const rows = await this.db()
      .prepare(
        `SELECT symbol, enabled, last_success_at, last_attempt_at, consecutive_failures,
                next_attempt_after, backoff_seconds, last_error
         FROM symbol_state ${where}
         ORDER BY ${sort} ${order}, symbol ASC
         LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all();

    return {
      ok: true,
      filter,
      total: countRow ? (countRow.c as number) : 0,
      items: rows.results.map((r) => ({
        symbol: r.symbol,
        enabled: r.enabled,
        last_success_at: r.last_success_at,
        last_attempt_at: r.last_attempt_at,
        consecutive_failures: r.consecutive_failures,
        next_attempt_after: r.next_attempt_after,
        backoff_seconds: r.backoff_seconds,
        last_error: r.last_error,
      })),
    };
  }
}

// Back-compat alias for the original CBOE driver name. It is the same scheduler
// configured with the cboe-options job; kept so existing callers/tests that
// reference the old class name keep compiling.
export class CboeContinuousLoader extends EtlScheduler {}
