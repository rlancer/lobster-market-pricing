import { describe, expect, it, vi } from "vitest";
import { earningsDailyJob, earningsDateList } from "./earnings-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const PIPELINE_EARNINGS_URL = "https://pipeline.test/earnings";

// Fixture payload (subset of the live Nasdaq capture, 2026-08-10) — the job
// fetches one calendar per date, so a date-keyed stub returns the same rows.
const NASDAQ_PAYLOAD = {
  data: {
    rows: [
      {
        time: "time-after-hours", symbol: "SPG", name: "Simon Property Group, Inc.",
        fiscalQuarterEnding: "Jun/2026", epsForecast: "$3.18", noOfEsts: "7",
      },
      {
        time: "time-after-hours", symbol: "AAPL", name: "Apple Inc.",
        fiscalQuarterEnding: "Jun/2026", epsForecast: "$2.54", noOfEsts: "18",
      },
      // Non-manifest symbols present on the calendar — must be filtered out.
      {
        time: "time-pre-market", symbol: "ZZZZ", name: "Not In Universe Holdings",
        fiscalQuarterEnding: "Jun/2026", epsForecast: "$1.00", noOfEsts: "2",
      },
    ],
  },
};

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return {
    EARNINGS_CONCURRENCY: 2,
    ...overrides,
  };
}

describe("earningsDateList", () => {
  it("spans today through today + lookahead - 1", () => {
    const now = Date.UTC(2026, 7, 8);
    expect(earningsDateList(now, 3)).toEqual(["2026-08-08", "2026-08-09", "2026-08-10"]);
  });
});

describe("earnings-daily job adapter", () => {
  it("dry-runs: with no pipeline URL it runs no fetches and reports no work", async () => {
    let fetched = 0;
    const stub = async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    };
    vi.stubGlobal("fetch", stub);
    try {
      const job = earningsDailyJob(env({ PIPELINE_EARNINGS_URL: undefined }));
      expect(job.scope).toBe("batch");
      const run = await job.run(["2026-08-08", "2026-08-09"], env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes one calendar per date, keeps only manifest symbols, and shares one run_id", async () => {
    const posts: Array<{ body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("nasdaq.com")) {
        return new Response(JSON.stringify(NASDAQ_PAYLOAD), { status: 200 });
      }
      posts.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const job = earningsDailyJob(env({
      PIPELINE_EARNINGS_URL,
      PIPELINE_AUTH_TOKEN: "tok",
      HTTP_RETRIES: 0,
      runId: () => "run-1",
    }));
    const run = await job.run(["2026-08-08", "2026-08-09", "2026-08-10"], env({
      PIPELINE_EARNINGS_URL,
      PIPELINE_AUTH_TOKEN: "tok",
      HTTP_RETRIES: 0,
      runId: () => "run-1",
    }));
    expect(run.failures).toEqual([]);
    expect(run.runId).toBe("run-1");
    expect(posts).toHaveLength(3);

    for (const p of posts) {
      const rows = p.body as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.symbol).sort()).toEqual(["AAPL", "SPG"]);
      for (const r of rows) {
        expect(r.run_id).toBe("run-1");
        expect(r.source).toBe("nasdaq");
      }
    }
    // Each date's records carry that date.
    const byDate = new Map(
      posts.map((p) => {
        const rows = p.body as Array<Record<string, unknown>>;
        return [rows[0].earnings_date as string, rows];
      }),
    );
    expect([...byDate.keys()].sort()).toEqual(["2026-08-08", "2026-08-09", "2026-08-10"]);
  });

  it("records a per-date failure without aborting the rest", async () => {
    let nasdaqCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("nasdaq.com")) {
        nasdaqCalls += 1;
        if (url.includes("date=2026-08-09")) {
          return new Response("boom", { status: 503 });
        }
        return new Response(JSON.stringify(NASDAQ_PAYLOAD), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const job = earningsDailyJob(env({
      PIPELINE_EARNINGS_URL,
      HTTP_RETRIES: 0,
      runId: () => "run-2",
    }));
    const run = await job.run(["2026-08-08", "2026-08-09"], env({
      PIPELINE_EARNINGS_URL,
      HTTP_RETRIES: 0,
      runId: () => "run-2",
    }));
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0].symbol).toBe("2026-08-09");
    expect(run.failures[0].error).toMatch(/HTTP 503/);
    expect(nasdaqCalls).toBe(2);
  });
});