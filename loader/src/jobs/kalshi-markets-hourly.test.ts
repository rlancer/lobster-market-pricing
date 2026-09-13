import { describe, expect, it, vi } from "vitest";
import { kalshiMarketsHourlyJob } from "./kalshi-markets-hourly.js";
import type { SchedulerEnv } from "../scheduler.js";
import { kalshiSeriesList } from "../kalshi.js";

const PIPELINE_KALSHI_MARKETS_URL = "https://pipeline.test/kalshi";
const UNIVERSE = kalshiSeriesList();

const SAMPLE = {
  markets: [{
    ticker: "KXFED-27APR-T4.25",
    event_ticker: "KXFED-27APR",
    title: "Fed funds above 4.25%?",
    yes_sub_title: "Above 4.25%",
    status: "active",
    market_type: "binary",
    yes_bid_dollars: "0.16",
    yes_ask_dollars: "0.35",
    last_price_dollars: "0.17",
    volume_fp: "100",
    volume_24h_fp: "10",
    open_interest_fp: "50",
    close_time: "2027-04-28T17:55:00Z",
  }],
  cursor: "",
};

const MVE_COMBO = {
  ticker: "KXNFLPARLAY-26SEP13-KCBUF",
  event_ticker: "KXNFLPARLAY-26SEP13",
  series_ticker: "KXNFLPARLAY",
  title: "Chiefs win AND Bills win",
  category: "Sports",
  status: "active",
  mve_collection_ticker: "KXMVESPORT-NFL",
  mve_selected_legs: [
    { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-KC", side: "yes" },
    { event_ticker: "KXNFLGAME-26SEP13BUF", market_ticker: "KXNFLGAME-26SEP13BUF-BUF", side: "yes" },
  ],
  yes_bid_dollars: "0.20",
  yes_ask_dollars: "0.24",
  last_price_dollars: "0.22",
  volume_fp: "500",
  volume_24h_fp: "80",
  close_time: "2026-09-14T00:00:00Z",
};

const MVE_LEGS = {
  markets: [
    {
      ticker: "KXNFLGAME-26SEP13KC-KC",
      event_ticker: "KXNFLGAME-26SEP13KC",
      series_ticker: "KXNFLGAME",
      title: "Chiefs win",
      status: "active",
      yes_bid_dollars: "0.55",
      yes_ask_dollars: "0.57",
      last_price_dollars: "0.56",
      volume_fp: "9000",
      close_time: "2026-09-14T00:00:00Z",
    },
    {
      ticker: "KXNFLGAME-26SEP13BUF-BUF",
      event_ticker: "KXNFLGAME-26SEP13BUF",
      series_ticker: "KXNFLGAME",
      title: "Bills win",
      status: "active",
      yes_bid_dollars: "0.48",
      yes_ask_dollars: "0.50",
      last_price_dollars: "0.49",
      volume_fp: "8000",
      close_time: "2026-09-14T00:00:00Z",
    },
  ],
  cursor: "",
};

function kalshiFetch(url: string, init: RequestInit | undefined, posts: unknown[]) {
  if (url.includes("/series/")) {
    return new Response(JSON.stringify({ series: { category: "Economics" } }), { status: 200 });
  }
  if (url.includes("/markets/candlesticks")) {
    return new Response(JSON.stringify({ markets: [] }), { status: 200 });
  }
  if (url.includes("mve_filter=only")) {
    if (url.includes("status=settled") || url.includes("status=closed")) {
      return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
    }
    return new Response(JSON.stringify({ markets: [MVE_COMBO], cursor: "" }), { status: 200 });
  }
  if (url.includes("tickers=")) {
    return new Response(JSON.stringify(MVE_LEGS), { status: 200 });
  }
  if (url.includes("/markets?")) {
    return new Response(JSON.stringify(SAMPLE), { status: 200 });
  }
  if (init?.method === "POST") {
    posts.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }
  return new Response("unexpected", { status: 500 });
}

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return { ...overrides } as SchedulerEnv;
}

describe("kalshi-markets-hourly job adapter", () => {
  it("dry-runs when PIPELINE_KALSHI_MARKETS_URL is unset", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = kalshiMarketsHourlyJob(env());
      expect(job.id).toBe("kalshi-markets-hourly");
      expect(job.scope).toBe("batch");
      expect(job.marketGated).toBe(false);
      expect(job.cadenceSeconds).toBe(3600);
      const run = await job.run(UNIVERSE, env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes every series with a shared run_id", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      return kalshiFetch(String(input), init, posts);
    });
    try {
      const job = kalshiMarketsHourlyJob(env());
      const run = await job.run(UNIVERSE, env({
        PIPELINE_KALSHI_MARKETS_URL,
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_SERIES_PACE_MS: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        runId: () => "run-1",
      }));
      expect(run.failures).toEqual([]);
      expect(run.runId).toBe("run-1");
      expect(posts).toHaveLength(UNIVERSE.length);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records a per-series failure without aborting the rest", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const isKxfedSeries = /\/series\/KXFED(?:\?|$)/.test(url);
      const isKxfedMarkets = url.includes("/markets?") && /[?&]series_ticker=KXFED(?:&|$)/.test(url);
      if (isKxfedSeries || isKxfedMarkets) {
        return new Response("boom", { status: 503 });
      }
      return kalshiFetch(url, init, posts);
    });
    try {
      const job = kalshiMarketsHourlyJob(env({ KALSHI_CONCURRENCY: 1, KALSHI_SERIES_PACE_MS: 0 }));
      const run = await job.run(UNIVERSE, env({
        PIPELINE_KALSHI_MARKETS_URL,
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_CONCURRENCY: 1,
        KALSHI_SERIES_PACE_MS: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        runId: () => "run-1",
      }));
      expect(run.failures).toHaveLength(1);
      expect(run.failures[0].symbol).toBe("KXFED");
      expect(run.runId).toBe("run-1");
      expect(posts).toHaveLength(UNIVERSE.length - 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
