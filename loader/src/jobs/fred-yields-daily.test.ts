import { describe, expect, it, vi } from "vitest";
import { fredYieldsDailyJob } from "./fred-yields-daily.js";
import type { SchedulerEnv } from "../scheduler.js";
import { yieldsSeriesList } from "../yields.js";

const PIPELINE_YIELDS_URL = "https://pipeline.test/yields";

const FRED_PAYLOAD = {
  observations: [
    { date: "2026-01-02", value: "4.25" },
    { date: "2026-01-06", value: "4.31" },
  ],
};

const UNIVERSE = yieldsSeriesList();

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return { ...overrides } as SchedulerEnv;
}

describe("fred-yields-daily job adapter", () => {
  it("dry-runs: with no pipeline URL it runs no fetches and reports no work", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = fredYieldsDailyJob(env({ PIPELINE_YIELDS_URL: undefined }));
      expect(job.scope).toBe("batch");
      expect(job.id).toBe("fred-yields-daily");
      const run = await job.run(UNIVERSE, env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes every series, shares one run_id, and reports no failures", async () => {
    const posts: Array<{ body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("stlouisfed.org")) {
        return new Response(JSON.stringify(FRED_PAYLOAD), { status: 200 });
      }
      posts.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const job = fredYieldsDailyJob(env());
      const run = await job.run(UNIVERSE, env({
        PIPELINE_YIELDS_URL,
        PIPELINE_AUTH_TOKEN: "tok",
        FRED_API_KEY: "fredkey",
        HTTP_RETRIES: 0,
        runId: () => "run-1",
      }));
      expect(run.failures).toEqual([]);
      expect(run.runId).toBe("run-1");
      expect(posts).toHaveLength(UNIVERSE.length);
      for (const p of posts) {
        const rows = p.body as Array<Record<string, unknown>>;
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
          expect(r.run_id).toBe("run-1");
          expect(r.source).toBe("fred");
          expect(r.fetched_at).toBeTruthy();
        }
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records a per-series failure without aborting the rest", async () => {
    const posts: Array<{ body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("stlouisfed.org")) {
        if (url.includes("series_id=DGS10")) {
          return new Response("boom", { status: 503 });
        }
        return new Response(JSON.stringify(FRED_PAYLOAD), { status: 200 });
      }
      posts.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const job = fredYieldsDailyJob(env({ YIELDS_CONCURRENCY: 1 }));
      const run = await job.run(UNIVERSE, env({
        PIPELINE_YIELDS_URL,
        PIPELINE_AUTH_TOKEN: "tok",
        FRED_API_KEY: "fredkey",
        HTTP_RETRIES: 0,
        YIELDS_CONCURRENCY: 1,
        runId: () => "run-1",
      }));
      expect(run.failures).toHaveLength(1);
      expect(run.failures[0].symbol).toBe("DGS10");
      expect(run.runId).toBe("run-1");
      expect(posts).toHaveLength(UNIVERSE.length - 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
