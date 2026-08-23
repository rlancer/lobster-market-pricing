import { describe, expect, it, vi } from "vitest";
import { companyFactsDailyJob, companyFactsUniverse } from "./company-facts-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const PIPELINE_COMPANY_FACTS_URL = "https://pipeline.test/company-facts";

function factsPayload(): unknown {
  return {
    facts: {
      "us-gaap": {
        NetIncomeLoss: {
          units: {
            USD: [
              {
                end: "2026-06-27",
                val: 1e9,
                fy: 2026,
                fp: "Q3",
                form: "10-Q",
                filed: "2026-07-31",
                frame: "CY2026Q2",
              },
            ],
          },
        },
        AllocatedShareBasedCompensationExpense: {
          units: {
            USD: [
              {
                end: "2026-06-27",
                val: 2e8,
                fy: 2026,
                fp: "Q3",
                form: "10-Q",
                filed: "2026-07-31",
                frame: "CY2026Q2",
              },
            ],
          },
        },
      },
    },
  };
}

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return { COMPANY_FACTS_CONCURRENCY: 2, ...overrides };
}

describe("companyFactsUniverse", () => {
  it("is the equity sleeve (no ETFs)", () => {
    const symbols = companyFactsUniverse();
    expect(symbols).toContain("AAPL");
    expect(symbols).not.toContain("QQQ");
  });
});

describe("company-facts-daily job adapter", () => {
  it("dry-runs without pipeline URL", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = companyFactsDailyJob(env());
      expect(job.id).toBe("company-facts-daily");
      const run = await job.run(["AAPL"], env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes company fact rows for equities with a CIK", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes("company_tickers")) {
        return new Response(
          JSON.stringify({ "0": { cik_str: 320193, ticker: "AAPL", title: "Apple" } }),
          { status: 200 },
        );
      }
      if (url.includes("companyfacts")) {
        return new Response(JSON.stringify(factsPayload()), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    const jobEnv = env({
      PIPELINE_COMPANY_FACTS_URL,
      PIPELINE_AUTH_TOKEN: "tok",
      HTTP_RETRIES: 0,
      runId: () => "run-cf",
    });
    const job = companyFactsDailyJob(jobEnv);
    const run = await job.run(["AAPL"], jobEnv);
    expect(run.failures).toEqual([]);
    expect(run.runId).toBe("run-cf");
    expect(posts).toHaveLength(1);
    const rows = posts[0].body as Array<{
      ticker: string;
      share_based_compensation: number;
      net_income: number;
    }>;
    expect(rows[0].ticker).toBe("AAPL");
    expect(rows[0].net_income).toBe(1e9);
    expect(rows[0].share_based_compensation).toBe(2e8);
  });
});
