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
    // Any other DO request (e.g. the worker's auto-arm ping): make sure the
    // loop is armed.
    await this.ensureArmed();
    return json({ ok: true });
  }

  async ensureArmed() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) {
      const pollMs = Math.floor(num(this.env, "LOADER_POLL_INTERVAL_SECONDS", 60) * 1000);
      await this.ctx.storage.setAlarm(Date.now() + pollMs);
    }
  }

  async alarm() {
    try {
      await this.tick();
    } catch (error) {
      // Never let a bad pass stop the loop. Log and re-arm.
      console.log(JSON.stringify({ event: "pass_error", error: String((error && error.message) || error) }));
    } finally {
      // Re-arm unconditionally so the loop is self-sustaining.
      const pollMs = Math.floor(num(this.env, "LOADER_POLL_INTERVAL_SECONDS", 60) * 1000);
      await this.ctx.storage.setAlarm(Date.now() + pollMs);
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
    return {
      ok: true,
      driver: "continuous",
      counts,
      last_pass: lastPassRow ? JSON.parse(lastPassRow.value) : null,
      next_alarm: await this.ctx.storage.getAlarm(),
      passing: !!(await this.ctx.storage.get("passing")),
    };
  }
}
