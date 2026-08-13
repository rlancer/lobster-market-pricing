import { describe, expect, it, vi } from "vitest";
import { etfDailyJob, etfUniverse } from "./etf-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const PIPELINE_ETF_PROFILES_URL = "https://pipeline.test/etf-profiles";
const PIPELINE_ETF_HOLDINGS_URL = "https://pipeline.test/etf-holdings";

function quotePayload(symbol: string): unknown {
  return {
    quoteSummary: {
      result: [
        {
          fundProfile: {
            family: "Test Family",
            categoryName: "Large Blend",
            legalType: "Exchange Traded Fund",
            feesExpensesInvestment: { annualReportExpenseRatio: { raw: 0.0009 } },
          },
          defaultKeyStatistics: { totalAssets: { raw: 1e9 }, fundInceptionDate: { fmt: "1993-01-22" } },
          summaryDetail: { yield: { raw: 0.01 } },
          topHoldings: {
            holdings: [
              { symbol: "AAPL", holdingName: "Apple", holdingPercent: { raw: 0.07 } },
            ],
          },
        },
      ],
    },
  };
}

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return { ETF_CONCURRENCY: 2, ...overrides };
}

describe("etfUniverse", () => {
  it("is the curated ETF manifest (optionable names, not the full 583)", () => {
    const symbols = etfUniverse();
    expect(symbols).toContain("SPY");
    expect(symbols).toContain("QQQ");
    expect(symbols).toContain("TQQQ");
    expect(symbols).not.toContain("AAPL");
    expect(symbols.length).toBeGreaterThanOrEqual(60);
  });
});

describe("etf-daily job adapter", () => {
  it("dry-runs: with no pipeline URLs it runs no fetches and reports no work", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = etfDailyJob(env());
      expect(job.scope).toBe("batch");
      expect(job.id).toBe("etf-daily");
      const run = await job.run(["SPY", "QQQ"], env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes a profile + holdings row per ETF and shares one run_id", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init && init.method) === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const symbol = decodeURIComponent((url.match(/quoteSummary\/([^?]+)/) ?? [])[1] ?? "UNK");
      return new Response(JSON.stringify(quotePayload(symbol)), { status: 200 });
    });
    const jobEnv = env({
      PIPELINE_ETF_PROFILES_URL,
      PIPELINE_ETF_HOLDINGS_URL,
      PIPELINE_AUTH_TOKEN: "tok",
      HTTP_RETRIES: 0,
      runId: () => "run-etf",
      yahooSession: { cookie: "A=1", crumb: "c" },
    });
    const job = etfDailyJob(jobEnv);
    const run = await job.run(["SPY", "QQQ"], jobEnv);
    expect(run.failures).toEqual([]);
    expect(run.runId).toBe("run-etf");
    const profiles = posts.filter((p) => p.url === PIPELINE_ETF_PROFILES_URL);
    const holdings = posts.filter((p) => p.url === PIPELINE_ETF_HOLDINGS_URL);
    expect(profiles).toHaveLength(2);
    expect(holdings).toHaveLength(2);
    const tickers = profiles.flatMap((p) => (p.body as Array<{ ticker: string }>).map((r) => r.ticker)).sort();
    expect(tickers).toEqual(["QQQ", "SPY"]);
    expect(profiles.every((p) => (p.body as Array<{ run_id: string }>)[0].run_id === "run-etf")).toBe(true);
    expect((holdings[0].body as Array<{ holding_symbol: string }>)[0].holding_symbol).toBe("AAPL");
  });

  it("records a per-symbol failure without aborting the rest", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init && init.method) === "POST") {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const url = String(input);
      if (url.includes("quoteSummary/BAD")) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify(quotePayload("SPY")), { status: 200 });
    });
    const jobEnv = env({
      PIPELINE_ETF_PROFILES_URL,
      HTTP_RETRIES: 0,
      runId: () => "run-2",
      yahooSession: { cookie: "A=1", crumb: "c" },
    });
    const job = etfDailyJob(jobEnv);
    const run = await job.run(["SPY", "BAD"], jobEnv);
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0].symbol).toBe("BAD");
    expect(run.failures[0].error).toMatch(/HTTP 404/);
  });
});
