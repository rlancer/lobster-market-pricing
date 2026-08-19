import { describe, expect, it, vi } from "vitest";
import { cryptoSpotOhlcDailyJob, cryptoSpotOhlcUniverse } from "./crypto-spot-ohlc-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const OHLC_URL = "https://ohlc.test/{symbol}";
const PIPELINE_OHLC_URL = "https://pipeline.test/ohlc";
const PIPELINE_RV_URL = "https://pipeline.test/rv";

function chartPayload(symbol: string): unknown {
  return {
    chart: {
      result: [
        {
          meta: { symbol, gmtoffset: 0, instrumentType: "CRYPTOCURRENCY" },
          timestamp: [1767312000, 1767398400],
          indicators: {
            quote: [
              {
                open: [90_000, 91_000], high: [92_000, 93_000], low: [89_000, 90_000],
                close: [91_000, 92_000], volume: [1_000, 1_100],
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
    CRYPTO_SPOT_OHLC_CONCURRENCY: 2,
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

describe("cryptoSpotOhlcUniverse", () => {
  it("is the curated spot-crypto Yahoo manifest", () => {
    const symbols = cryptoSpotOhlcUniverse();
    expect(symbols).toContain("BTC-USD");
    expect(symbols).toContain("ETH-USD");
    expect(symbols).toContain("SOL-USD");
    expect(symbols).toContain("XRP-USD");
    expect(symbols).not.toContain("IBIT");
    expect(symbols).not.toContain("BTC=F");
    expect(symbols).not.toContain("AAPL");
    expect(symbols.length).toBe(8);
  });
});

describe("crypto-spot-ohlc-daily job adapter", () => {
  it("dry-runs: with no pipeline URLs it runs no fetches and reports no work", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = cryptoSpotOhlcDailyJob(env());
      expect(job.id).toBe("crypto-spot-ohlc-daily");
      expect(job.scope).toBe("batch");
      expect(job.marketGated).toBe(false);
      const result = await job.run(["BTC-USD", "ETH-USD"], env());
      expect(result).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes OHLC for spot crypto and URL-encodes hyphens", async () => {
    const ohlcPosts: Array<{ body: string }> = [];
    const sourceUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init && init.method) === "POST") {
        if (url === PIPELINE_OHLC_URL) ohlcPosts.push({ body: String(init?.body) });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      sourceUrls.push(url);
      const encoded = url.split("/").pop() ?? "UNK";
      const symbol = decodeURIComponent(encoded);
      return new Response(JSON.stringify(chartPayload(symbol)), { status: 200 });
    });
    try {
      const job = cryptoSpotOhlcDailyJob(pipelineEnv());
      const result = await job.run(["BTC-USD", "ETH-USD"], pipelineEnv());
      expect(result.failures).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(ohlcPosts).toHaveLength(2);
    const records = ohlcPosts.flatMap((p) => JSON.parse(p.body));
    expect(new Set(records.map((r: { symbol: string }) => r.symbol))).toEqual(
      new Set(["BTC-USD", "ETH-USD"]),
    );
    expect(sourceUrls.some((u) => u.includes("BTC-USD") || u.includes("BTC%2DUSD"))).toBe(true);
  });

  it("collects a per-symbol failure without aborting the rest", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init && init.method) === "POST") return new Response("{}", { status: 200 });
      const symbol = decodeURIComponent(url.split("/").pop() ?? "UNK");
      if (symbol === "BAD-USD") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(chartPayload(symbol)), { status: 200 });
    });
    try {
      const job = cryptoSpotOhlcDailyJob(pipelineEnv());
      const result = await job.run(["BTC-USD", "BAD-USD"], pipelineEnv());
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].symbol).toBe("BAD-USD");
      expect(String(result.failures[0].error)).toMatch(/HTTP 404/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
