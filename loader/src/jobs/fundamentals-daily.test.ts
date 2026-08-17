import { describe, expect, it, vi } from "vitest";
import { fundamentalsDailyJob, fundamentalsUniverse } from "./fundamentals-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const PIPELINE_FUNDAMENTALS_URL = "https://pipeline.test/fundamentals";

function quotePayload(symbol: string): unknown {
  return {
    quoteSummary: {
      result: [
        {
          summaryDetail: {
            marketCap: { raw: symbol === "AAPL" ? 3e12 : 2e12 },
            trailingPE: { raw: 30 },
            forwardPE: { raw: 28 },
          },
          defaultKeyStatistics: { enterpriseValue: { raw: 3.1e12 }, pegRatio: { raw: 2 } },
          financialData: {
            totalDebt: { raw: 1e11 },
            debtToEquity: { raw: 140 },
            profitMargins: { raw: 0.2 },
            revenueGrowth: { raw: 0.05 },
          },
        },
      ],
    },
  };
}

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return { FUNDAMENTALS_CONCURRENCY: 2, ...overrides };
}

describe("fundamentalsUniverse", () => {
  it("is the equity sleeve of universe.json (no ETFs)", () => {
    const symbols = fundamentalsUniverse();
    expect(symbols).toContain("AAPL");
    expect(symbols).toContain("MSFT");
    expect(symbols).toContain("ASML"); // nasdaq100 delta
    expect(symbols).not.toContain("SPY");
    expect(symbols).not.toContain("QQQ");
    expect(symbols.length).toBeGreaterThanOrEqual(500);
  });
});

describe("fundamentals-daily job adapter", () => {
  it("dry-runs: with no pipeline URL it runs no fetches and reports no work", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = fundamentalsDailyJob(env());
      expect(job.scope).toBe("batch");
      expect(job.id).toBe("fundamentals-daily");
      const run = await job.run(["AAPL", "MSFT"], env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes a fundamentals row per equity and shares one run_id", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const symbol = decodeURIComponent((url.match(/quoteSummary\/([^?]+)/) ?? [])[1] ?? "UNK");
      return new Response(JSON.stringify(quotePayload(symbol)), { status: 200 });
    });
    const jobEnv = env({
      PIPELINE_FUNDAMENTALS_URL,
      PIPELINE_AUTH_TOKEN: "tok",
      HTTP_RETRIES: 0,
      runId: () => "run-fund",
      yahooSession: { cookie: "A=1", crumb: "c" },
    });
    const job = fundamentalsDailyJob(jobEnv);
    const run = await job.run(["AAPL", "MSFT"], jobEnv);
    expect(run.failures).toEqual([]);
    expect(run.runId).toBe("run-fund");
    expect(posts).toHaveLength(2);
    const tickers = posts
      .flatMap((p) => (p.body as Array<{ ticker: string }>).map((r) => r.ticker))
      .sort();
    expect(tickers).toEqual(["AAPL", "MSFT"]);
    expect(posts.every((p) => (p.body as Array<{ source: string }>)[0].source === "yahoo")).toBe(true);
    const aapl = (posts.find((p) => (p.body as Array<{ ticker: string }>)[0].ticker === "AAPL")!
      .body as Array<{ market_cap: number }>)[0];
    expect(aapl.market_cap).toBe(3e12);
  });

  it("records a per-symbol failure without aborting the rest", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init && init.method) === "POST") {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const url = String(input);
      if (url.includes("quoteSummary/BAD")) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify(quotePayload("AAPL")), { status: 200 });
    });
    const jobEnv = env({
      PIPELINE_FUNDAMENTALS_URL,
      HTTP_RETRIES: 0,
      runId: () => "run-2",
      yahooSession: { cookie: "A=1", crumb: "c" },
    });
    const job = fundamentalsDailyJob(jobEnv);
    const run = await job.run(["AAPL", "BAD"], jobEnv);
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0].symbol).toBe("BAD");
    expect(run.failures[0].error).toMatch(/HTTP 404/);
  });
});
