import { describe, expect, it, vi } from "vitest";
import { instrumentsDailyJob } from "./instruments-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const PIPELINE_INSTRUMENTS_URL = "https://pipeline.test/instruments";

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return { ...overrides };
}

describe("instruments-daily job adapter", () => {
  it("dry-runs with no pipeline URL", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = instrumentsDailyJob(env());
      expect(job.scope).toBe("batch");
      expect(job.id).toBe("instruments-daily");
      expect(await job.universe()).toEqual(["catalog"]);
      const run = await job.run(["catalog"], env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes the catalog once and shares one run_id", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const jobEnv = env({
        PIPELINE_INSTRUMENTS_URL,
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        runId: () => "run-inst",
      });
      const job = instrumentsDailyJob(jobEnv);
      const run = await job.run(["catalog"], jobEnv);
      expect(run.failures).toEqual([]);
      expect(run.runId).toBe("run-inst");
      expect(posts).toHaveLength(1);
      expect(posts[0].url).toBe(PIPELINE_INSTRUMENTS_URL);
      const body = posts[0].body as Array<{ symbol: string; security_type: string; run_id: string }>;
      expect(body.length).toBeGreaterThan(600);
      expect(body.every((r) => r.run_id === "run-inst")).toBe(true);
      expect(body.find((r) => r.symbol === "SPY")?.security_type).toBe("etf");
      expect(body.find((r) => r.symbol === "AAPL")?.security_type).toBe("equity");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records a catalog failure when the pipeline rejects", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 400 }));
    try {
      const jobEnv = env({
        PIPELINE_INSTRUMENTS_URL,
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        runId: () => "run-bad",
      });
      const job = instrumentsDailyJob(jobEnv);
      const run = await job.run(["catalog"], jobEnv);
      expect(run.runId).toBe("run-bad");
      expect(run.failures).toHaveLength(1);
      expect(run.failures[0].symbol).toBe("catalog");
      expect(run.failures[0].error).toMatch(/HTTP 400/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
