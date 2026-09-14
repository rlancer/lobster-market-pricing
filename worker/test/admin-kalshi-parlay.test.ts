import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXECUTOR_JOB_ID,
  HOURLY_JOB_ID,
  buildKalshiParlayMonitor,
  emptyExecutorView,
  fetchKalshiParlayMonitor,
  handleAdminKalshiParlay,
  loaderBaseUrl,
  shapeExecutorJob,
  shapeHourlyJob,
  shapeLoopStatus,
  triggerKalshiParlayPass,
  type KalshiParlayAdminEnv,
} from "../src/admin-kalshi-parlay.ts";

const NOW = Date.parse("2026-09-14T14:00:00.000Z");

function executorPayload(detail: Record<string, unknown>, jobExtra: Record<string, unknown> = {}) {
  return {
    ok: true,
    job: {
      job_id: EXECUTOR_JOB_ID,
      handler: EXECUTOR_JOB_ID,
      scope: "batch",
      enabled: 1,
      cadence_seconds: 300,
      market_gated: 0,
      next_attempt_after: NOW + 60_000,
      last_success_at: NOW - 120_000,
      consecutive_failures: 0,
      backoff_seconds: 0,
      last_error: null,
      last_pass: {
        at: NOW - 90_000,
        finished_at: NOW - 89_000,
        run_id: null,
        attempted: 1,
        succeeded: 1,
        failed: 0,
        duration_ms: 1400,
        detail,
      },
      ...jobExtra,
    },
  };
}

function hourlyPayload(detail: Record<string, unknown> = {
  rfq_probe: "skipped_executor",
  live: false,
}) {
  return {
    ok: true,
    job: {
      job_id: HOURLY_JOB_ID,
      enabled: 1,
      last_success_at: NOW - 1_800_000,
      last_error: null,
      last_pass: {
        at: NOW - 1_800_000,
        attempted: 12,
        detail,
      },
    },
  };
}

const idleDetail = {
  execute: false,
  live: false,
  idle_reason: "execute_off",
  open_combos: 80,
  open_legs: 400,
  combo_legs: 80,
  two_leg: 7,
  same_game_two_leg: 0,
  cross_game_two_leg: 7,
  missing_leg_mids: 0,
  samples: [
    { market_ticker: "KXMVE-A", n_legs: 3, game_group: "same_game", tape: "sports" },
  ],
  attempted: 0,
  would_accept: 0,
  accepted: 0,
  skipped: 0,
  decisions: [],
};

describe("shapeExecutorJob", () => {
  it("reads RFQ counts from last_pass.detail, not job-level attempted", () => {
    const view = shapeExecutorJob(executorPayload({
      execute: true,
      live: false,
      contracts: 10,
      max_accepts_per_pass: 1,
      idle_reason: null,
      open_combos: 80,
      two_leg: 7,
      same_game_two_leg: 1,
      cross_game_two_leg: 6,
      attempted: 1,
      would_accept: 1,
      accepted: 0,
      skipped: 0,
      decisions: [{
        market_ticker: "KXMVE-GAME",
        would_accept: true,
        accepted: false,
        reasons: [],
        error: null,
        yes_bid: 0.18,
        yes_ask: 0.22,
        rfq_id: "rfq1",
        quote_id: "q1",
      }],
    }));
    assert.equal(view.execute, true);
    assert.equal(view.live, false);
    assert.equal(view.idle_reason, null);
    assert.equal(view.pass_attempted, 1);
    assert.equal(view.attempted, 1);
    assert.equal(view.would_accept, 1);
    assert.equal(view.accepted, 0);
    assert.equal(view.same_game_two_leg, 1);
    assert.equal(view.decisions[0]?.quote_id, "q1");
    assert.equal(view.decisions[0]?.yes_ask, 0.22);
    assert.equal(view.contracts, 10);
    assert.equal(view.max_accepts_per_pass, 1);
  });

  it("treats truncated last_pass.detail as missing telemetry", () => {
    const view = shapeExecutorJob(executorPayload({ truncated: true }));
    assert.equal(view.execute, false);
    assert.equal(view.idle_reason, null);
    assert.equal(view.attempted, 0);
    assert.equal(view.decisions.length, 0);
    assert.equal(view.contracts, 10);
    assert.equal(view.max_accepts_per_pass, 1);
    assert.equal(view.last_pass_at, NOW - 90_000);
  });

  it("coerces idle_reason and 0/1 flags", () => {
    const view = shapeExecutorJob(executorPayload({
      execute: "1",
      live: 0,
      idle_reason: "no_targets",
    }));
    assert.equal(view.execute, true);
    assert.equal(view.live, false);
    assert.equal(view.idle_reason, "no_targets");
  });

  it("returns empty defaults when the loader blob is unusable", () => {
    const view = shapeExecutorJob({ ok: false, error: "unknown job" });
    assert.deepEqual(view.job_id, emptyExecutorView().job_id);
    assert.equal(view.enabled, false);
    assert.equal(view.execute, false);
  });
});

describe("shapeHourlyJob + shapeLoopStatus", () => {
  it("surfaces rfq_probe skipped_executor", () => {
    const hourly = shapeHourlyJob(hourlyPayload());
    assert.equal(hourly?.rfq_probe, "skipped_executor");
    assert.equal(hourly?.live, false);
  });

  it("reads loop passing and next_alarm", () => {
    const loop = shapeLoopStatus({ ok: true, passing: true, next_alarm: NOW + 5000 });
    assert.equal(loop?.passing, true);
    assert.equal(loop?.next_alarm, NOW + 5000);
  });
});

describe("buildKalshiParlayMonitor", () => {
  it("keeps executor data when hourly/loop fail", () => {
    const monitor = buildKalshiParlayMonitor({
      executor: executorPayload(idleDetail),
      hourly: null,
      hourlyError: "loader 502: down",
      loop: null,
      loopError: "loader 502: down",
      nowMs: NOW,
    });
    assert.equal(monitor.fetched_at, "2026-09-14T14:00:00.000Z");
    assert.equal(monitor.executor.open_combos, 80);
    assert.equal(monitor.executor.same_game_two_leg, 0);
    assert.equal(monitor.hourly, null);
    assert.equal(monitor.loop, null);
    assert.match(monitor.errors.hourly ?? "", /502/);
  });
});

function mockFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (input) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([path]) => url.includes(path));
    if (!hit) return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 500 });
    return new Response(JSON.stringify(hit[1].body), {
      status: hit[1].status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const env: KalshiParlayAdminEnv = {
  LOADER_BASE_URL: "https://loader.test",
  LOADER_TOKEN: "sekrit",
};

describe("fetchKalshiParlayMonitor", () => {
  it("GETs executor, hourly, and loop/status — never Kalshi", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input) => {
      urls.push(String(input));
      return mockFetch({
        [`/jobs/${EXECUTOR_JOB_ID}`]: { body: executorPayload(idleDetail) },
        [`/jobs/${HOURLY_JOB_ID}`]: { body: hourlyPayload() },
        "/loop/status": { body: { ok: true, passing: false, next_alarm: NOW } },
      })(input);
    }) as typeof fetch;
    const monitor = await fetchKalshiParlayMonitor(env, fetchImpl, NOW);
    assert.deepEqual(urls.sort(), [
      "https://loader.test/jobs/kalshi-markets-hourly",
      "https://loader.test/jobs/kalshi-parlay-executor",
      "https://loader.test/loop/status",
    ].sort());
    assert.equal(monitor.executor.idle_reason, "execute_off");
    assert.equal(monitor.hourly?.rfq_probe, "skipped_executor");
    assert.equal(monitor.loop?.passing, false);
    assert.ok(urls.every((url) => !url.includes("kalshi.com")));
  });

  it("throws when the executor job fetch fails", async () => {
    const fetchImpl = mockFetch({
      [`/jobs/${EXECUTOR_JOB_ID}`]: { status: 500, body: { error: "boom" } },
    });
    await assert.rejects(
      () => fetchKalshiParlayMonitor(env, fetchImpl, NOW),
      /loader 500/,
    );
  });
});

describe("triggerKalshiParlayPass", () => {
  it("returns 503 when LOADER_TOKEN is missing", async () => {
    const result = await triggerKalshiParlayPass({ LOADER_BASE_URL: "https://loader.test" }, mockFetch({}));
    assert.equal(result.status, 503);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error ?? "", /LOADER_TOKEN/);
  });

  it("POSTs force=1&async=1 with the bearer token", async () => {
    let url = "";
    let auth = "";
    let method = "";
    const fetchImpl = (async (input, init) => {
      url = String(input);
      auth = String(init?.headers && new Headers(init.headers).get("Authorization"));
      method = String(init?.method);
      return new Response(JSON.stringify({ ok: true, job: EXECUTOR_JOB_ID, background: true, note: "forced pass started" }), { status: 200 });
    }) as typeof fetch;
    const result = await triggerKalshiParlayPass(env, fetchImpl);
    assert.equal(method, "POST");
    assert.equal(url, "https://loader.test/jobs/kalshi-parlay-executor/trigger?force=1&async=1");
    assert.equal(auth, "Bearer sekrit");
    assert.equal(result.status, 200);
    assert.equal(result.body.background, true);
  });
});

describe("handleAdminKalshiParlay", () => {
  const fetchImpl = mockFetch({
    [`/jobs/${EXECUTOR_JOB_ID}`]: { body: executorPayload(idleDetail) },
    [`/jobs/${HOURLY_JOB_ID}`]: { body: hourlyPayload() },
    "/loop/status": { body: { ok: true, passing: false, next_alarm: null } },
    "/trigger?force=1": { body: { ok: true, job: EXECUTOR_JOB_ID, background: true } },
  });

  it("returns null for unrelated paths", async () => {
    const res = await handleAdminKalshiParlay(env, new Request("https://api.test/api/admin/quality-gate"), "/api/admin/quality-gate", {
      requireAdmin: async () => ({ ok: true }),
      fetchImpl,
    });
    assert.equal(res, null);
  });

  it("returns 401 without admin", async () => {
    const res = await handleAdminKalshiParlay(env, new Request("https://api.test/api/admin/kalshi-parlay"), "/api/admin/kalshi-parlay", {
      requireAdmin: async () => ({ ok: false, status: 401, error: "unauthorized" }),
      fetchImpl,
    });
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    const body = await res.json() as { error: string };
    assert.equal(body.error, "unauthorized");
  });

  it("returns 200 with execute/live/idle_reason for an authorized GET", async () => {
    const res = await handleAdminKalshiParlay(env, new Request("https://api.test/api/admin/kalshi-parlay"), "/api/admin/kalshi-parlay", {
      requireAdmin: async () => ({ ok: true }),
      fetchImpl,
    });
    assert.ok(res);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      executor: { execute: boolean; live: boolean; idle_reason: string | null };
    };
    assert.equal(body.executor.execute, false);
    assert.equal(body.executor.live, false);
    assert.equal(body.executor.idle_reason, "execute_off");
  });

  it("returns 503 on trigger when LOADER_TOKEN is unset", async () => {
    const res = await handleAdminKalshiParlay(
      { LOADER_BASE_URL: "https://loader.test" },
      new Request("https://api.test/api/admin/kalshi-parlay/trigger", { method: "POST" }),
      "/api/admin/kalshi-parlay/trigger",
      {
        requireAdmin: async () => ({ ok: true }),
        fetchImpl,
      },
    );
    assert.ok(res);
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.match(body.error, /LOADER_TOKEN/);
  });
});

describe("loaderBaseUrl", () => {
  it("strips trailing slashes and falls back to production", () => {
    assert.equal(loaderBaseUrl({ LOADER_BASE_URL: "https://x.test/" }), "https://x.test");
    assert.match(loaderBaseUrl({}), /cboe-to-r2/);
  });
});
