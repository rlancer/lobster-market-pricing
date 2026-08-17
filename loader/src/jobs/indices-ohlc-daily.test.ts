import { describe, expect, it, vi } from "vitest";
import { indicesOhlcDailyJob, indicesOhlcUniverse } from "./indices-ohlc-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const OHLC_URL = "https://ohlc.test/{symbol}";
const PIPELINE_OHLC_URL = "https://pipeline.test/ohlc";
const PIPELINE_RV_URL = "https://pipeline.test/rv";

function chartPayload(symbol: string): unknown {
  return {
    chart: {
      result: [
        {
          meta: { symbol, gmtoffset: -18000, instrumentType: "INDEX" },
          timestamp: [1767312000, 1767398400],
          indicators: {
            quote: [
              {
                open: [14, 15], high: [15, 16], low: [13, 14],
                close: [14.5, 15.5], volume: [0, 0],
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
    INDICES_OHLC_CONCURRENCY: 2,
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

describe("indicesOhlcUniverse", () => {
  it("is the curated CBOE vol-index Yahoo manifest", () => {
    const symbols = indicesOhlcUniverse();
    expect(symbols).toContain("^VIX");
    expect(symbols).toContain("^VVIX");
    expect(symbols).toContain("^VIX9D");
    expect(symbols).toContain("^VIX3M");
    expect(symbols).toContain("^SKEW");
    expect(symbols).toContain("^VXN");
    expect(symbols).not.toContain("AAPL");
    expect(symbols).not.toContain("VXX");
    expect(symbols.length).toBe(6);
  });
});

describe("indices-ohlc-daily job adapter", () => {
  it("dry-runs: with no pipeline URLs it runs no fetches and reports no work", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = indicesOhlcDailyJob(env());
      expect(job.id).toBe("indices-ohlc-daily");
      expect(job.scope).toBe("batch");
      const result = await job.run(["^VIX", "^VVIX"], env());
      expect(result).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes OHLC for vol-index symbols and URL-encodes ^", async () => {
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
      const job = indicesOhlcDailyJob(pipelineEnv());
      const result = await job.run(["^VIX", "^VVIX"], pipelineEnv());
      expect(result.failures).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(ohlcPosts).toHaveLength(2);
    const records = ohlcPosts.flatMap((p) => JSON.parse(p.body));
    expect(new Set(records.map((r: { symbol: string }) => r.symbol))).toEqual(
      new Set(["^VIX", "^VVIX"]),
    );
    expect(sourceUrls.some((u) => u.includes("%5EVIX"))).toBe(true);
    expect(sourceUrls.some((u) => u.includes("%5EVVIX"))).toBe(true);
  });

  it("collects a per-symbol failure without aborting the rest", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init && init.method) === "POST") return new Response("{}", { status: 200 });
      const symbol = decodeURIComponent(url.split("/").pop() ?? "UNK");
      if (symbol === "^BAD") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(chartPayload(symbol)), { status: 200 });
    });
    try {
      const job = indicesOhlcDailyJob(pipelineEnv());
      const result = await job.run(["^VIX", "^BAD"], pipelineEnv());
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].symbol).toBe("^BAD");
      expect(String(result.failures[0].error)).toMatch(/HTTP 404/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
