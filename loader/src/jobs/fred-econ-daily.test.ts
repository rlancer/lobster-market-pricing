import { describe, expect, it, vi } from "vitest";
import { fredEconDailyJob } from "./fred-econ-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const PIPELINE_ECON_URL = "https://pipeline.test/econ";

// Fixtures mirror the module tests: FRED returns one release's scheduled
// dates; the Fed calendar returns FOMC/Beige events.
const FRED_PAYLOAD = {
  release_dates: [
    { release_id: 10, date: "2026-01-13" },
    { release_id: 10, date: "2026-08-12" },
  ],
};
const FED_PAYLOAD = {
  events: [
    { title: "FOMC Meeting", type: "FOMC", month: "2026-09", days: "16" },
    { title: "Beige Book", type: "Beige", month: "2026-09", days: "2" },
  ],
};

// The job's universe: one source per allowlisted FRED release + the Fed calendar.
const UNIVERSE = [
  "fred:10", "fred:46", "fred:50", "fred:53", "fred:54", "fred:91", "federalreserve",
];

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return { ...overrides } as SchedulerEnv;
}

describe("fred-econ-daily job adapter", () => {
  it("dry-runs: with no pipeline URL it runs no fetches and reports no work", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = fredEconDailyJob(env({ PIPELINE_ECON_URL: undefined }));
      expect(job.scope).toBe("batch");
      const run = await job.run(UNIVERSE, env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes every source, shares one run_id, and reports no failures", async () => {
    const posts: Array<{ body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("stlouisfed.org")) {
        return new Response(JSON.stringify(FRED_PAYLOAD), { status: 200 });
      }
      if (url.includes("federalreserve.gov")) {
        return new Response(JSON.stringify(FED_PAYLOAD), { status: 200 });
      }
      posts.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const job = fredEconDailyJob(env());
      const run = await job.run(UNIVERSE, env({
        PIPELINE_ECON_URL,
        PIPELINE_AUTH_TOKEN: "tok",
        FRED_API_KEY: "fredkey",
        HTTP_RETRIES: 0,
        runId: () => "run-1",
      }));
      expect(run.failures).toEqual([]);
      expect(run.runId).toBe("run-1");
      // 6 FRED releases + 1 Fed calendar = 7 posts.
      expect(posts).toHaveLength(7);

      for (const p of posts) {
        const rows = p.body as Array<Record<string, unknown>>;
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
          expect(r.run_id).toBe("run-1");
          expect(r.fetched_at).toBeTruthy();
        }
      }
      // Each source lands with its own source tag.
      const sources = new Set(
        posts.flatMap((p) => (p.body as Array<Record<string, unknown>>).map((r) => r.source)),
      );
      expect(sources.has("fred")).toBe(true);
      expect(sources.has("federalreserve")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records a per-source failure without aborting the rest", async () => {
    const posts: Array<{ body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("stlouisfed.org")) {
        if (url.includes("release_id=46")) {
          return new Response("boom", { status: 503 });
        }
        return new Response(JSON.stringify(FRED_PAYLOAD), { status: 200 });
      }
      if (url.includes("federalreserve.gov")) {
        return new Response(JSON.stringify(FED_PAYLOAD), { status: 200 });
      }
      posts.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const job = fredEconDailyJob(env());
      const run = await job.run(UNIVERSE, env({
        PIPELINE_ECON_URL,
        PIPELINE_AUTH_TOKEN: "tok",
        FRED_API_KEY: "fredkey",
        HTTP_RETRIES: 0,
        runId: () => "run-1",
      }));
      // release_id=46 (PPI) failed; the other 6 sources still published.
      expect(run.failures).toHaveLength(1);
      expect(run.failures[0].symbol).toBe("fred:46");
      expect(run.runId).toBe("run-1");
      expect(posts).toHaveLength(6);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});