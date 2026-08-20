import { describe, expect, it, vi } from "vitest";
import { regShoDailyJob } from "./reg-sho-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const PIPELINE_REG_SHO_URL = "https://pipeline.test/regsho";

const FINRA_PAGE = [
  {
    reportingFacilityCode: "NQTRF",
    totalParQuantity: 1000,
    shortParQuantity: 400,
    marketCode: "Q",
    tradeReportDate: "2026-08-18",
    securitiesInformationProcessorSymbolIdentifier: "AAPL",
    shortExemptParQuantity: 10,
  },
  {
    reportingFacilityCode: "NYTRF",
    totalParQuantity: 500,
    shortParQuantity: 100,
    marketCode: "N",
    tradeReportDate: "2026-08-18",
    securitiesInformationProcessorSymbolIdentifier: "AAPL",
    shortExemptParQuantity: 0,
  },
  {
    reportingFacilityCode: "NQTRF",
    totalParQuantity: 50,
    shortParQuantity: 10,
    marketCode: "Q",
    tradeReportDate: "2026-08-18",
    securitiesInformationProcessorSymbolIdentifier: "ZZZZ",
    shortExemptParQuantity: 0,
  },
];

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return {
    REG_SHO_CONCURRENCY: 2,
    ...overrides,
  };
}

describe("reg-sho-daily job adapter", () => {
  it("dry-runs: with no pipeline URL it runs no fetches and reports no work", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = regShoDailyJob(env({ PIPELINE_REG_SHO_URL: undefined }));
      expect(job.scope).toBe("batch");
      expect(job.id).toBe("reg-sho-daily");
      expect(job.marketGated).toBe(false);
      const run = await job.run(["2026-08-18", "2026-08-17"], env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes per trade date, keeps only universe symbols, shares one run_id", async () => {
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
      const job = regShoDailyJob(
        env({
          PIPELINE_REG_SHO_URL,
          PIPELINE_AUTH_TOKEN: "tok",
          HTTP_RETRIES: 0,
          runId: () => "run-1",
        }),
      );
      const run = await job.run(
        ["2026-08-18", "2026-08-17"],
        env({
          PIPELINE_REG_SHO_URL,
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
        expect(rows[0].short_volume).toBe(500);
        expect(rows[0].facility_count).toBe(2);
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
        if (date === "2026-08-17") {
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
      const job = regShoDailyJob(
        env({
          PIPELINE_REG_SHO_URL,
          HTTP_RETRIES: 0,
          runId: () => "run-2",
        }),
      );
      const run = await job.run(
        ["2026-08-18", "2026-08-17"],
        env({
          PIPELINE_REG_SHO_URL,
          HTTP_RETRIES: 0,
          runId: () => "run-2",
        }),
      );
      expect(run.failures).toHaveLength(1);
      expect(run.failures[0].symbol).toBe("2026-08-17");
      expect(run.failures[0].error).toMatch(/HTTP 503/);
      expect(finraCalls).toBeGreaterThanOrEqual(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("universe() returns trade-date candidates", async () => {
    const job = regShoDailyJob(env({ REG_SHO_LOOKBACK_DAYS: 5 }));
    const items = await Promise.resolve(job.universe());
    expect(items).toHaveLength(5);
    expect(items.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  });
});
