import { describe, expect, it, vi } from "vitest";
import { shortInterestDailyJob } from "./short-interest-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const PIPELINE_SHORT_INTEREST_URL = "https://pipeline.test/si";

const FINRA_PAGE = [
  {
    stockSplitFlag: null,
    previousShortPositionQuantity: 100,
    averageDailyVolumeQuantity: 50,
    issueName: "Apple Inc. Common Stock",
    currentShortPositionQuantity: 120,
    changePreviousNumber: 20,
    accountingYearMonthNumber: 20260731,
    settlementDate: "2026-07-31",
    marketClassCode: "NNM",
    symbolCode: "AAPL",
    daysToCoverQuantity: 2.4,
    issuerServicesGroupExchangeCode: "R",
    revisionFlag: null,
    changePercent: 20,
  },
  {
    stockSplitFlag: null,
    previousShortPositionQuantity: 10,
    averageDailyVolumeQuantity: 5,
    issueName: "Noise",
    currentShortPositionQuantity: 11,
    changePreviousNumber: 1,
    accountingYearMonthNumber: 20260731,
    settlementDate: "2026-07-31",
    marketClassCode: "NNM",
    symbolCode: "ZZZZ",
    daysToCoverQuantity: 1,
    issuerServicesGroupExchangeCode: "R",
    revisionFlag: null,
    changePercent: 10,
  },
];

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return {
    SHORT_INTEREST_CONCURRENCY: 2,
    ...overrides,
  };
}

describe("short-interest-daily job adapter", () => {
  it("dry-runs: with no pipeline URL it runs no fetches and reports no work", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = shortInterestDailyJob(env({ PIPELINE_SHORT_INTEREST_URL: undefined }));
      expect(job.scope).toBe("batch");
      expect(job.id).toBe("short-interest-daily");
      expect(job.marketGated).toBe(false);
      const run = await job.run(["2026-07-31", "2026-07-15"], env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes per settlement date, keeps only universe symbols, shares one run_id", async () => {
    const posts: Array<{ body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("finra.org")) {
        const req = JSON.parse(String(init?.body)) as { offset: number };
        if (req.offset === 0) {
          return new Response(JSON.stringify(FINRA_PAGE), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      posts.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const job = shortInterestDailyJob(
        env({
          PIPELINE_SHORT_INTEREST_URL,
          PIPELINE_AUTH_TOKEN: "tok",
          HTTP_RETRIES: 0,
          runId: () => "run-1",
        }),
      );
      const run = await job.run(
        ["2026-07-31", "2026-07-15"],
        env({
          PIPELINE_SHORT_INTEREST_URL,
          PIPELINE_AUTH_TOKEN: "tok",
          HTTP_RETRIES: 0,
          runId: () => "run-1",
        }),
      );
      expect(run.failures).toEqual([]);
      expect(run.runId).toBe("run-1");
      expect(posts).toHaveLength(2);
      for (const p of posts) {
        const rows = p.body as Array<Record<string, unknown>>;
        expect(rows.map((r) => r.symbol)).toEqual(["AAPL"]);
        expect(rows[0].run_id).toBe("run-1");
        expect(rows[0].source).toBe("finra");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records a per-date failure without aborting the rest", async () => {
    let finraCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("finra.org")) {
        finraCalls += 1;
        const req = JSON.parse(String(init?.body)) as {
          compareFilters: Array<{ fieldValue: string }>;
          offset: number;
        };
        const date = req.compareFilters[0]?.fieldValue;
        if (date === "2026-07-15") {
          return new Response("boom", { status: 503 });
        }
        if (req.offset === 0) {
          return new Response(JSON.stringify(FINRA_PAGE), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const job = shortInterestDailyJob(
        env({
          PIPELINE_SHORT_INTEREST_URL,
          HTTP_RETRIES: 0,
          runId: () => "run-2",
        }),
      );
      const run = await job.run(
        ["2026-07-31", "2026-07-15"],
        env({
          PIPELINE_SHORT_INTEREST_URL,
          HTTP_RETRIES: 0,
          runId: () => "run-2",
        }),
      );
      expect(run.failures).toHaveLength(1);
      expect(run.failures[0].symbol).toBe("2026-07-15");
      expect(run.failures[0].error).toMatch(/HTTP 503/);
      expect(finraCalls).toBeGreaterThanOrEqual(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("universe() returns settlement-date candidates", async () => {
    const job = shortInterestDailyJob(env({ SHORT_INTEREST_LOOKBACK_MONTHS: 1 }));
    const items = await Promise.resolve(job.universe());
    expect(items.length).toBeGreaterThan(2);
    expect(items.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  });
});