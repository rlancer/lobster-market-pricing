import { describe, expect, it, vi } from "vitest";
import { earningsResultsDailyJob, earningsResultsUniverse } from "./earnings-results-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const PIPELINE_EARNINGS_RESULTS_URL = "https://pipeline.test/earnings-results";

function historyPayload(symbol: string): unknown {
  return {
    quoteSummary: {
      result: [
        {
          earningsHistory: {
            history: [
              {
                epsActual: { raw: symbol === "AAPL" ? 1.85 : 2.0 },
                epsEstimate: { raw: 1.7 },
                epsDifference: { raw: 0.1 },
                surprisePercent: { raw: 0.05 },
                quarter: { fmt: "2025-09-30" },
                currency: "USD",
                period: "-1q",
              },
            ],
          },
        },
      ],
    },
  };
}

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return { EARNINGS_RESULTS_CONCURRENCY: 2, ...overrides };
}

describe("earningsResultsUniverse", () => {
  it("is the equity sleeve (no ETFs)", () => {
    const symbols = earningsResultsUniverse();
    expect(symbols).toContain("AAPL");
    expect(symbols).not.toContain("SPY");
  });
});

describe("earnings-results-daily job adapter", () => {
  it("dry-runs without pipeline URL", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = earningsResultsDailyJob(env());
      expect(job.id).toBe("earnings-results-daily");
      const run = await job.run(["AAPL"], env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes history rows and shares one run_id", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const symbol = decodeURIComponent((url.match(/quoteSummary\/([^?]+)/) ?? [])[1] ?? "UNK");
      return new Response(JSON.stringify(historyPayload(symbol)), { status: 200 });
    });
    const jobEnv = env({
      PIPELINE_EARNINGS_RESULTS_URL,
      PIPELINE_AUTH_TOKEN: "tok",
      HTTP_RETRIES: 0,
      runId: () => "run-er",
      yahooSession: { cookie: "A=1", crumb: "c" },
    });
    const job = earningsResultsDailyJob(jobEnv);
    const run = await job.run(["AAPL", "MSFT"], jobEnv);
    expect(run.failures).toEqual([]);
    expect(run.runId).toBe("run-er");
    expect(posts).toHaveLength(2);
    const aapl = posts.find((p) => (p.body as Array<{ symbol: string }>)[0].symbol === "AAPL")!
      .body as Array<{ eps_actual: number; quarter_end: string }>;
    expect(aapl[0].eps_actual).toBe(1.85);
    expect(aapl[0].quarter_end).toBe("2025-09-30");
  });
});
