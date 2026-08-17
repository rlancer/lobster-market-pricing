import { describe, expect, it, vi } from "vitest";
import { futuresOhlcDailyJob, futuresOhlcUniverse } from "./futures-ohlc-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const OHLC_URL = "https://ohlc.test/{symbol}";
const PIPELINE_OHLC_URL = "https://pipeline.test/ohlc";
const PIPELINE_RV_URL = "https://pipeline.test/rv";

function chartPayload(symbol: string): unknown {
  return {
    chart: {
      result: [
        {
          meta: { symbol, gmtoffset: -18000, instrumentType: "FUTURE" },
          timestamp: [1767312000, 1767398400],
          indicators: {
            quote: [
              {
                open: [100, 101], high: [101, 102], low: [99, 100],
                close: [100.5, 101.5], volume: [1000, 2000],
              },
            ],
          },
        },
      ],
    },
  };
}

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return {
    OHLC_URL_TEMPLATE: OHLC_URL,
    OHLC_SOURCE: "yahoo",
    FUTURES_OHLC_CONCURRENCY: 2,
    ...overrides,
  };
}

function pipelineEnv(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return env({
    PIPELINE_OHLC_URL,
    PIPELINE_REALIZED_VOL_URL: PIPELINE_RV_URL,
    PIPELINE_AUTH_TOKEN: "tok",
    HTTP_RETRIES: 0,
    ...overrides,
  });
}

describe("futuresOhlcUniverse", () => {
  it("is the curated continuous Yahoo futures manifest", () => {
    const symbols = futuresOhlcUniverse();
    expect(symbols).toContain("ES=F");
    expect(symbols).toContain("NQ=F");
    expect(symbols).toContain("CL=F");
    expect(symbols).toContain("BTC=F");
    expect(symbols).not.toContain("AAPL");
    expect(symbols).not.toContain("VXU26");
    expect(symbols.length).toBeGreaterThanOrEqual(15);
  });
});

describe("futures-ohlc-daily job adapter", () => {
  it("dry-runs: with no pipeline URLs it runs no fetches and reports no work", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = futuresOhlcDailyJob(env());
      expect(job.id).toBe("futures-ohlc-daily");
      expect(job.scope).toBe("batch");
      const result = await job.run(["ES=F", "NQ=F"], env());
      expect(result).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes OHLC for continuous futures symbols", async () => {
    const ohlcPosts: Array<{ body: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init && init.method) === "POST") {
        if (url === PIPELINE_OHLC_URL) ohlcPosts.push({ body: String(init?.body) });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const symbol = decodeURIComponent(url.split("/").pop() ?? "UNK");
      return new Response(JSON.stringify(chartPayload(symbol)), { status: 200 });
    });
    try {
      const job = futuresOhlcDailyJob(pipelineEnv());
      const result = await job.run(["ES=F", "NQ=F"], pipelineEnv());
      expect(result.failures).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(ohlcPosts).toHaveLength(2);
    const records = ohlcPosts.flatMap((p) => JSON.parse(p.body));
    expect(new Set(records.map((r: { symbol: string }) => r.symbol))).toEqual(
      new Set(["ES=F", "NQ=F"]),
    );
  });

  it("collects a per-symbol failure without aborting the rest", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init && init.method) === "POST") return new Response("{}", { status: 200 });
      const symbol = decodeURIComponent(url.split("/").pop() ?? "UNK");
      if (symbol === "BAD=F") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(chartPayload(symbol)), { status: 200 });
    });
    try {
      const job = futuresOhlcDailyJob(pipelineEnv());
      const result = await job.run(["ES=F", "BAD=F"], pipelineEnv());
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].symbol).toBe("BAD=F");
      expect(String(result.failures[0].error)).toMatch(/HTTP 404/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
