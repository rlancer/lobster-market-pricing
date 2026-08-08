import { describe, expect, it, vi } from "vitest";
import { ohlcDailyJob } from "./ohlc-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const OHLC_URL = "https://ohlc.test/{symbol}";
const PIPELINE_OHLC_URL = "https://pipeline.test/ohlc";
const PIPELINE_RV_URL = "https://pipeline.test/rv";

// Yahoo v8 chart shape with two ascending daily bars (gmtoffset -5h → ET).
function chartPayload(symbol: string): unknown {
  return {
    chart: {
      result: [
        {
          meta: { symbol, gmtoffset: -18000 },
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
    OHLC_CONCURRENCY: 2,
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

describe("ohlc-daily job adapter", () => {
  it("dry-runs: with no pipeline URLs it runs no fetches and reports no work", async () => {
    let fetched = 0;
    const stub = async () => {
      fetched++;
      return new Response("{}", { status: 200 });
    };
    vi.stubGlobal("fetch", stub);
    try {
      const job = ohlcDailyJob(env());
      const result = await job.run(["AAPL", "MSFT"], env());
      expect(result.failures).toEqual([]);
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes OHLC + realized-vol records for every universe symbol when configured", async () => {
    const ohlcPosts: Array<{ url: string; body: string }> = [];
    const rvPosts: Array<{ url: string; body: string }> = [];
    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if ((init && init.method) === "POST") {
        if (url === PIPELINE_OHLC_URL) ohlcPosts.push({ url, body: String(init?.body) });
        if (url === PIPELINE_RV_URL) rvPosts.push({ url, body: String(init?.body) });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      // GET: the Yahoo chart source — derive the symbol from the URL.
      const symbol = decodeURIComponent(url.split("/").pop() ?? "UNK");
      return new Response(JSON.stringify(chartPayload(symbol)), { status: 200 });
    };
    vi.stubGlobal("fetch", stub);
    try {
      const job = ohlcDailyJob(pipelineEnv());
      const result = await job.run(["AAPL", "MSFT"], pipelineEnv());
      expect(result.failures).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }

    // Two symbols → two OHLC publishes (2 daily bars each) + two RV publishes.
    expect(ohlcPosts).toHaveLength(2);
    const ohlcRecords = ohlcPosts.flatMap((p) => JSON.parse(p.body));
    expect(ohlcRecords).toHaveLength(4);
    expect(new Set(ohlcRecords.map((r) => r.symbol))).toEqual(new Set(["AAPL", "MSFT"]));
    expect(ohlcRecords.every((r) => r.source === "yahoo")).toBe(true);

    expect(rvPosts).toHaveLength(2);
    const rvRecords = rvPosts.flatMap((p) => JSON.parse(p.body));
    expect(rvRecords.map((r) => r.symbol).sort()).toEqual(["AAPL", "MSFT"]);
  });

  it("collects a per-symbol failure without aborting the rest", async () => {
    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if ((init && init.method) === "POST") return new Response("{}", { status: 200 });
      const symbol = decodeURIComponent(url.split("/").pop() ?? "UNK");
      if (symbol === "BAD") return new Response("not found", { status: 404 }); // → fetchOhlc throws
      return new Response(JSON.stringify(chartPayload(symbol)), { status: 200 });
    };
    vi.stubGlobal("fetch", stub);
    try {
      const job = ohlcDailyJob(pipelineEnv());
      const result = await job.run(["AAPL", "BAD"], pipelineEnv());
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].symbol).toBe("BAD");
      expect(String(result.failures[0].error)).toMatch(/HTTP 404/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
