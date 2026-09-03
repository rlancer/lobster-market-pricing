import { EtlScheduler, DRIVER_ID } from "./scheduler.js";
import { runSymbols } from "./run-symbols.js";
import { publishOhlc } from "./ohlc.js";
import { publishEtf } from "./etf.js";
import {
  enrollSymbol,
  listEnrolledRows,
  normalizeEnrollTicker,
} from "./enrolled-universe.js";

export { EtlScheduler };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authorized(request, env) {
  const configured = env.LOADER_TOKEN;
  if (!configured) return false;
  return request.headers.get("authorization") === `Bearer ${configured}`;
}

function driverStub(env) {
  return env.ETL_SCHEDULER.get(
    env.ETL_SCHEDULER.idFromName(DRIVER_ID),
  );
}

function loopEnabled(env) {
  return !!(env.ETL_SCHEDULER && env.CONTINUOUS_LOADER_ENABLED !== "false");
}

// The loop bootstraps itself: the first request to the Worker arms the driver
// DO (one alarm -> next alarm -> ... forever). Arming is idempotent and cheap.
// We route through the DO's `fetch` handler (which calls ensureArmed) rather
// than a method-RPC so arming is guaranteed to take effect.
function armDriver(env, ctx) {
  if (!loopEnabled(env)) return;
  const url = new URL("http://continuous-loader/loop/");
  ctx.waitUntil(
    driverStub(env)
      .fetch(url)
      .then((response) => response.text())
      .catch(() => {})
  );
}

// One-shot /run — the public refresh endpoint. Now runs the fetch+normalize+
// publish path in-process (runSymbols); the container it used to forward to is
// retired, so Pipeline URLs/token come straight from Worker env secrets.
async function handleRun(request, env) {
  let symbols = null;
  try {
    const body = await request.json();
    if (body && Array.isArray(body.symbols)) {
      symbols = body.symbols.filter((s) => typeof s === "string");
    }
  } catch {
    /* malformed body -> 400 below */
  }
  if (!symbols) {
    return json({ error: 'body must be {"symbols":["AAPL"]}' }, 400);
  }
  try {
    const result = await runSymbols(symbols, env);
    return json(result, result.run.status === "complete" ? 200 : 502);
  } catch (error) {
    // e.g. invalid symbols / over MAX_SYMBOLS — runSymbols rejects before publish.
    return json({ error: (error && error.message) || String(error) }, 400);
  }
}

/**
 * POST /symbols/enroll — durable on-demand enrollment.
 * Body: { symbol, source?, requested_by?, notes?, load_now?, security_type? }
 * Seeds enrolled_symbols + symbol_state / ohlc_backfill_state /
 * research_brief_state, optionally kicks an immediate CBOE+OHLC load
 * (and ETF profile/holdings when security_type is etf|fund).
 */
async function handleEnroll(request, env, ctx) {
  if (!env.LOADER_DB) {
    return json({ error: "LOADER_DB is not configured" }, 503);
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const raw = body && typeof body.symbol === "string" ? body.symbol : "";
  const symbol = normalizeEnrollTicker(raw);
  if (!symbol) {
    return json({ error: `invalid enrollable ticker: ${raw || "(empty)"}` }, 400);
  }
  const loadNow = body.load_now !== false;
  const securityType = typeof body.security_type === "string" ? body.security_type : null;
  try {
    const result = await enrollSymbol(env.LOADER_DB, symbol, {
      source: typeof body.source === "string" ? body.source : "on_demand",
      requestedBy: typeof body.requested_by === "string" ? body.requested_by : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      backoffBaseSeconds: Number(env.LOADER_BACKOFF_BASE_SECONDS) || 60,
      securityType,
    });
    armDriver(env, ctx);
    if (loadNow) {
      ctx.waitUntil(
        (async () => {
          try {
            await runSymbols([symbol], env);
          } catch (error) {
            console.log(JSON.stringify({
              event: "enroll_run_symbols_error",
              symbol,
              error: String((error && error.message) || error),
            }));
          }
          try {
            if (env.PIPELINE_OHLC_URL || env.PIPELINE_REALIZED_VOL_URL) {
              await publishOhlc(symbol, env);
            }
          } catch (error) {
            console.log(JSON.stringify({
              event: "enroll_publish_ohlc_error",
              symbol,
              error: String((error && error.message) || error),
            }));
          }
          const type = String(securityType || "").trim().toLowerCase();
          if (type === "etf" || type === "fund" || type === "mutualfund" || type === "mutual_fund") {
            try {
              if (env.PIPELINE_ETF_PROFILES_URL || env.PIPELINE_ETF_HOLDINGS_URL) {
                await publishEtf(symbol, env, {});
              }
            } catch (error) {
              console.log(JSON.stringify({
                event: "enroll_publish_etf_error",
                symbol,
                error: String((error && error.message) || error),
              }));
            }
          }
        })(),
      );
    }
    return json({ ...result, load_now: loadNow, security_type: securityType });
  } catch (error) {
    return json({ error: (error && error.message) || String(error) }, 500);
  }
}

async function handleEnrolledList(request, env) {
  if (!env.LOADER_DB) {
    return json({ error: "LOADER_DB is not configured" }, 503);
  }
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || 100);
  const offset = Number(url.searchParams.get("offset") || 0);
  const rows = await listEnrolledRows(env.LOADER_DB, { limit, offset });
  return json({ symbols: rows, count: rows.length });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Continuous-loader driver routes. /loop/trigger and /loop/arm are
    // write-like and protected by LOADER_TOKEN; /loop/status is read-only.
    if (url.pathname.startsWith("/loop/")) {
      if (!loopEnabled(env)) {
        return new Response("Continuous loader disabled\n", { status: 404 });
      }
      if (
        (url.pathname === "/loop/trigger" || url.pathname === "/loop/arm") &&
        !authorized(request, env)
      ) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      return driverStub(env).fetch(request);
    }

    // Job-aware observability. /jobs and /jobs/{id} are read-only; the manual
    // kick /jobs/{id}/trigger is write-like and protected by LOADER_TOKEN.
    if (url.pathname === "/jobs" || url.pathname.startsWith("/jobs/")) {
      if (!loopEnabled(env)) {
        return new Response("Continuous loader disabled\n", { status: 404 });
      }
      if (url.pathname.endsWith("/trigger") && !authorized(request, env)) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      return driverStub(env).fetch(request);
    }

    if (url.pathname === "/health" || url.pathname === "/status") {
      armDriver(env, ctx);
      return json({
        ok: true,
        loader: {
          status: "idle",
          write_mode: "pipeline",
          note: "loader runs in-process; see /loop/status for continuous state",
        },
      });
    }

    if (url.pathname === "/symbols/enroll" && request.method === "POST") {
      if (!authorized(request, env)) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      return handleEnroll(request, env, ctx);
    }

    if (url.pathname === "/symbols/enrolled" && request.method === "GET") {
      if (!authorized(request, env)) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      return handleEnrolledList(request, env);
    }

    if (url.pathname !== "/run" || request.method !== "POST") {
      return new Response("Not found\n", { status: 404 });
    }
    if (!authorized(request, env)) {
      return new Response("Unauthorized\n", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }
    // Run the one-shot load in-process and arm the continuous loop on the way
    // through (keeps the existing /run behavior fully intact and backward
    // compatible — it now fetches the same way the DO's pass does).
    armDriver(env, ctx);
    return handleRun(request, env);
  },
};
