// Continuous CBOE loader driver — a Durable Object alarm loop.
//
// A single DO instance arms a self-rescheduling alarm. On each alarm it:
//   1. seeds `symbol_state` from the S&P 500 manifest on first run,
//   2. picks the small batch of due symbols (next_attempt_after <= now),
//   3. calls the existing CboeLoaderContainer `/run` with that batch (reusing
//      the same pipeline-header plumbing as the public /run endpoint), and
//   4. updates per-symbol D1 state: success resets backoff and schedules the
//      next reload at CADENCE; failure bumps `consecutive_failures`, doubles
//      `backoff_seconds` up to CAP, and sets `next_attempt_after` accordingly.
//
// Single-flight: a DO processes one `alarm()` at a time and we only re-arm in
// the `finally`, so two passes can never overlap. A `passing` storage flag
// additionally guards any manual /loop/trigger against an in-flight pass.
//
// Cost note: this driver's own CPU is negligible (small indexed D1 read, one
// container HTTP call, a handful of D1 writes per pass). The real spend is the
// CBOE fetches and Pipeline/R2 writes in the container, which scale only with
// refresh volume — so the safe/cost-conscious move is a modest BATCH_SIZE and
// POLL interval (see wrangler.jsonc vars and README for tuning).

import { getContainer } from "@cloudflare/containers";
import sp500 from "../symbols/sp500.json";

export const DRIVER_ID = "continuous-loader-v1";
export const LOADER_ID = "cboe-loader-v3";

const SYMBOLS = Array.isArray(sp500.symbols) ? sp500.symbols : [];

function num(env, key, dflt) {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// ---------------------------------------------------------------------------
// US market-hours gating
//
// CBOE S&P 500 quotes only change during the regular US session
// (09:30–16:00 ET, Mon–Fri, excluding US market holidays; some days close
// early at 13:00 ET). When the market is closed there is no new data, so to
// avoid wasting CPU / DO-wakes / container + Pipeline spend we sleep the
// alarm loop until the next open (a single far-out alarm) and skip passes
// entirely. MARKET_HOURS_ENABLED="false" restores the always-on behavior.
// ---------------------------------------------------------------------------
const MIN = 60000;
const HOUR = 3600000;

function nthWeekdayDayOfMonth(year, month0, weekday, n) {
  const first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

function lastWeekdayDayOfMonth(year, month0, weekday) {
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month0, days)).getUTCDay();
  const offset = (last - weekday + 7) % 7;
  return days - offset;
}

// Gregorian Computus — Easter as a UTC-midnight epoch (ms).
function easterUtcMs(year) {
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
function isUcDst(utcMs) {
  const y = new Date(utcMs).getUTCFullYear();
  const start = Date.UTC(y, 2, nthWeekdayDayOfMonth(y, 2, 0, 2), 7);
  const end = Date.UTC(y, 10, nthWeekdayDayOfMonth(y, 10, 0, 1), 6);
  return utcMs >= start && utcMs < end;
}

// ET offset (hours behind UTC) at a given instant: 5 (EST) / 4 (EDT).
function etOffsetHours(utcMs) {
  return isUcDst(utcMs) ? 4 : 5;
}

// ET wall-clock view of `utcMs` as a synthetic UTC Date whose calendar fields
// read as America/New_York local time.
function etWall(utcMs) {
  return new Date(utcMs - etOffsetHours(utcMs) * HOUR);
}

// Fully-closed US market holiday for an ET wall-clock date `w`.
function isHolidayClosed(w) {
  const y = w.getUTCFullYear();
  const mo = w.getUTCMonth(), d = w.getUTCDate();
  const on = (m0, day) => mo === m0 && d === day;
  const observed = (m0, day) => {
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
function isEarlyClose(w) {
  const y = w.getUTCFullYear();
  const bf = new Date(Date.UTC(y, 10, nthWeekdayDayOfMonth(y, 10, 4, 4) + 1));
  return (
    (w.getUTCMonth() === 11 && w.getUTCDate() === 24) ||
    (w.getUTCMonth() === bf.getUTCMonth() && w.getUTCDate() === bf.getUTCDate())
  );
}

function marketHoursEnabled(env) {
  return (env && env.MARKET_HOURS_ENABLED) !== "false";
}

function marketState(nowMs, env) {
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
function nextOpenMs(nowMs, env) {
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

// When the next alarm should fire: poll cadence while open, otherwise sleep
// until the next market open.
function nextWakeMs(env, nowMs) {
  const pollMs = Math.floor(num(env, "LOADER_POLL_INTERVAL_SECONDS", 60) * 1000);
  if (!marketHoursEnabled(env)) return nowMs + pollMs;
  const st = marketState(nowMs, env);
  return st.open ? nowMs + pollMs : (st.next_open != null ? st.next_open : nowMs + pollMs);
}

// Reused by both the public /run endpoint and the driver's internal call so the
// container always receives the correct, authenticated Pipeline URLs/token.
export function pipelineHeaders(env) {
  const headers = {
    "x-pipeline-runs-url": env.PIPELINE_RUNS_URL,
    "x-pipeline-contracts-url": env.PIPELINE_CONTRACTS_URL,
    "x-pipeline-underlyings-url": env.PIPELINE_UNDERLYINGS_URL,
    "x-pipeline-errors-url": env.PIPELINE_ERRORS_URL,
    "x-pipeline-auth-token": env.PIPELINE_AUTH_TOKEN,
  };
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value) out[name] = value;
  }
  return out;
}

export function buildRunRequest(symbols, env) {
  const request = new Request("http://cboe-loader/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbols }),
  });
  for (const [name, value] of Object.entries(pipelineHeaders(env))) {
    request.headers.set(name, value);
  }
  return request;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class CboeContinuousLoader {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/loop/trigger") {
      // Manual kick (auth-gated at the Worker edge). Serializes with the alarm
      // via the `passing` flag inside tick().
      await this.tick();
      await this.ensureArmed();
      return json({ ok: true, note: "tick completed" });
    }
    if (url.pathname === "/loop/status") {
      return json(await this.status());
    }
    if (url.pathname === "/loop/symbols") {
      return json(await this.symbols(url));
    }
    // Any other DO request (e.g. the worker's auto-arm ping): make sure the
    // loop is armed.
    await this.ensureArmed();
    return json({ ok: true });
  }

  async ensureArmed() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) {
      await this.ctx.storage.setAlarm(nextWakeMs(this.env, Date.now()));
    }
  }

  async alarm() {
    try {
      await this.tick();
    } catch (error) {
      // Never let a bad pass stop the loop. Log and re-arm.
      console.log(JSON.stringify({ event: "pass_error", error: String((error && error.message) || error) }));
    } finally {
      // Re-arm unconditionally so the loop is self-sustaining. While the
      // market is closed this sleeps until the next open rather than polling.
      await this.ctx.storage.setAlarm(nextWakeMs(this.env, Date.now()));
    }
  }

  async seedIfEmpty() {
    const row = await this.env.LOADER_DB.prepare("SELECT COUNT(*) AS c FROM symbol_state").first();
    if (row.c > 0) return false;
    const now = Date.now();
    const base = num(this.env, "LOADER_BACKOFF_BASE_SECONDS", 60);
    for (const symbol of SYMBOLS) {
      await this.env.LOADER_DB.prepare(
        `INSERT OR IGNORE INTO symbol_state
           (symbol, enabled, last_success_at, last_attempt_at, consecutive_failures,
            next_attempt_after, backoff_seconds, last_error, priority)
         VALUES (?, 1, NULL, NULL, 0, ?, ?, NULL, 0)`
      ).bind(symbol, now, base).run();
    }
    console.log(JSON.stringify({ event: "seeded_symbol_state", symbols: SYMBOLS.length }));
    return true;
  }

  async pickDue(batchSize) {
    const now = Date.now();
    const rows = await this.env.LOADER_DB.prepare(
      `SELECT symbol FROM symbol_state
       WHERE enabled = 1 AND next_attempt_after <= ?
       ORDER BY priority ASC, last_success_at ASC NULLS FIRST
       LIMIT ?`
    ).bind(now, batchSize).all();
    return rows.results.map((r) => r.symbol);
  }

  async markAttempts(symbols, now) {
    const placeholders = symbols.map(() => "?").join(",");
    await this.env.LOADER_DB.prepare(
      `UPDATE symbol_state SET last_attempt_at = ? WHERE symbol IN (${placeholders})`
    ).bind(now, ...symbols).run();
  }

  async applyResults(batch, successSymbols, failMap, now, baseBackoff, capBackoff, cadence, transportError) {
    const db = this.env.LOADER_DB;
    const base = baseBackoff;
    for (const symbol of successSymbols) {
      await db.prepare(
        `UPDATE symbol_state
           SET last_success_at = ?, consecutive_failures = 0,
               backoff_seconds = ?, next_attempt_after = ?, last_error = NULL
         WHERE symbol = ?`
      ).bind(now, base, now + cadence * 1000, symbol).run();
    }
    for (const symbol of batch) {
      if (successSymbols.includes(symbol)) continue;
      const err = transportError
        ? `${transportError} (transport)`
        : (failMap.get(symbol) ?? "unknown");
      const row = await db
        .prepare("SELECT consecutive_failures FROM symbol_state WHERE symbol = ?")
        .bind(symbol)
        .first();
      const consecutive = (row && row.consecutive_failures ? row.consecutive_failures : 0) + 1;
      // Backoff tiers: 60s → 5m → 30m, then capped at the cap (×1, ×5, ×30 of
      // the base). Matches the documented "60s → 5m → 30m → cap" progression.
      const tier = Math.min(consecutive - 1, 2);
      const mult = [1, 5, 30][tier];
      const backoff = Math.min(baseBackoff * mult, capBackoff);
      await db.prepare(
        `UPDATE symbol_state
           SET consecutive_failures = ?, backoff_seconds = ?,
               next_attempt_after = ?, last_error = ?
         WHERE symbol = ?`
      ).bind(consecutive, backoff, now + backoff * 1000, err, symbol).run();
    }
  }

  async storeMeta(key, value) {
    await this.env.LOADER_DB.prepare(
      `INSERT INTO loader_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, JSON.stringify(value), Date.now()).run();
  }

  async tick() {
    if (await this.ctx.storage.get("passing")) return; // single-flight guard
    // Outside regular market hours there is no new CBOE data; skip the pass
    // (no container call / no D1 writes) and let alarm() sleep until open.
    if (marketHoursEnabled(this.env) && !marketState(Date.now(), this.env).open) return;
    await this.ctx.storage.put("passing", true);
    try {
      const env = this.env;
      const batchSize = Math.max(1, Math.floor(num(env, "LOADER_BATCH_SIZE", 10)));
      const baseBackoff = num(env, "LOADER_BACKOFF_BASE_SECONDS", 60);
      const capBackoff = num(env, "LOADER_BACKOFF_CAP_SECONDS", 1800);
      const cadence = num(env, "LOADER_CADENCE_SECONDS", 900);
      const runTimeoutMs = Math.max(1000, Math.floor(num(env, "LOADER_RUN_TIMEOUT_SECONDS", 300) * 1000));

      await this.seedIfEmpty();
      const batch = await this.pickDue(batchSize);
      if (batch.length === 0) return; // nothing due this pass

      const now = Date.now();
      await this.markAttempts(batch, now);

      const started = Date.now();
      let failures = [];
      let runId = null;
      let transportError = null;
      try {
        const container = getContainer(env.CBOE_LOADER, LOADER_ID);
        const response = await container.fetch(buildRunRequest(batch, env), {
          signal: AbortSignal.timeout(runTimeoutMs),
        });
        const body = await response.json();
        runId = (body && body.run && body.run.run_id) || null;
        if (Array.isArray(body && body.failures)) {
          failures = body.failures.map((f) => ({
            symbol: f && f.symbol,
            error: String((f && f.error) || "unknown"),
          }));
        }
      } catch (error) {
        transportError = String((error && error.message) || error);
      }

      const failMap = new Map(failures.filter((f) => f.symbol).map((f) => [f.symbol, f.error]));
      const successSymbols = batch.filter((s) => !failMap.has(s));

      await this.applyResults(
        batch, successSymbols, failMap, now,
        baseBackoff, capBackoff, cadence, transportError,
      );

      const pass = {
        at: now,
        finished_at: Date.now(),
        run_id: runId,
        attempted: batch.length,
        succeeded: successSymbols.length,
        failed: batch.length - successSymbols.length,
        batch,
        transport_error: transportError,
        duration_ms: Date.now() - started,
      };
      await this.storeMeta("last_pass", pass);
      console.log(JSON.stringify({
        event: "pass_completed",
        attempted: pass.attempted,
        succeeded: pass.succeeded,
        failed: pass.failed,
        run_id: runId,
        error: transportError,
      }));
    } finally {
      await this.ctx.storage.delete("passing");
    }
  }

  async status() {
    const now = Date.now();
    const counts = await this.env.LOADER_DB.prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled,
         COALESCE(SUM(CASE WHEN enabled = 1 AND next_attempt_after <= ? THEN 1 ELSE 0 END), 0) AS due,
         COALESCE(SUM(CASE WHEN enabled = 1 AND consecutive_failures > 0 THEN 1 ELSE 0 END), 0) AS failing
       FROM symbol_state`
    ).bind(now).first();
    const lastPassRow = await this.env.LOADER_DB
      .prepare(`SELECT value FROM loader_meta WHERE key = 'last_pass'`)
      .first();
    const m = marketState(now, this.env);
    return {
      ok: true,
      driver: "continuous",
      counts,
      last_pass: lastPassRow ? JSON.parse(lastPassRow.value) : null,
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

  // Read-only per-symbol listing for the Loading Status monitor. Never writes
  // to D1; every predicate is a single indexed scan of symbol_state. Supports
  // filter (all|enabled|disabled|failing|retrying|due|stale), q= symbol
  // substring, limit (default 100, max 1000), offset, and a whitelisted sort
  // (symbol|last_success_at|consecutive_failures) with optional order.
  async symbols(url) {
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

    const clauses = [];
    const params = [];
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
        // Enabled, not actively backing off, and data older than the cadence
        // (or never loaded). Matches the UI "Stale"/"Never loaded" semantics.
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

    const countRow = await this.env.LOADER_DB
      .prepare(`SELECT COUNT(*) AS c FROM symbol_state ${where}`)
      .bind(...params)
      .first();
    const rows = await this.env.LOADER_DB
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
      total: countRow ? countRow.c : 0,
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
