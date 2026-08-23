import { describe, expect, it, vi } from "vitest";
import {
  applySeriesCategory,
  kalshiSeriesList,
  normalizeKalshiRecords,
  parseKalshiMarketsPayload,
  parseKalshiNumber,
  publishKalshiSeries,
  rankKalshiMarkets,
  type KalshiMarketRow,
} from "./kalshi.js";

const SAMPLE_MARKET = {
  ticker: "KXFED-27APR-T4.25",
  event_ticker: "KXFED-27APR",
  title: "Will the upper bound of the federal funds rate be above 4.25%?",
  yes_sub_title: "Above 4.25%",
  status: "active",
  market_type: "binary",
  yes_bid_dollars: "0.1600",
  yes_ask_dollars: "0.3500",
  last_price_dollars: "0.1700",
  no_bid_dollars: "0.6500",
  no_ask_dollars: "0.8400",
  volume_fp: "10251.97",
  volume_24h_fp: "120.00",
  open_interest_fp: "2050.01",
  liquidity_dollars: "10.00",
  floor_strike: 4.25,
  close_time: "2027-04-28T17:55:00Z",
  expiration_time: "2027-05-05T18:05:00Z",
};

describe("kalshi parse helpers", () => {
  it("parseKalshiNumber handles dollar strings and numbers", () => {
    expect(parseKalshiNumber("0.1700")).toBeCloseTo(0.17);
    expect(parseKalshiNumber(0.35)).toBeCloseTo(0.35);
    expect(parseKalshiNumber("")).toBeNull();
    expect(parseKalshiNumber("nope")).toBeNull();
  });

  it("parseKalshiMarketsPayload maps open markets for an allowlisted series", () => {
    const rows = parseKalshiMarketsPayload("KXFED", { markets: [SAMPLE_MARKET] });
    expect(rows).toHaveLength(1);
    expect(rows[0].series_ticker).toBe("KXFED");
    expect(rows[0].market_ticker).toBe("KXFED-27APR-T4.25");
    expect(rows[0].theme).toBe("rates");
    expect(rows[0].related_symbol).toBe("TLT");
    expect(rows[0].yes_bid).toBeCloseTo(0.16);
    expect(rows[0].yes_ask).toBeCloseTo(0.35);
    expect(rows[0].floor_strike).toBe(4.25);
    expect(rows[0].source).toBe("kalshi");
  });

  it("rejects unknown series tickers", () => {
    expect(() => parseKalshiMarketsPayload("KXSPORTS", { markets: [] })).toThrow(/unknown series/);
  });

  it("rankKalshiMarkets prefers higher 24h volume then sooner close", () => {
    const base: KalshiMarketRow = {
      series_ticker: "KXFED",
      market_ticker: "A",
      event_ticker: null,
      title: "a",
      yes_subtitle: null,
      theme: "rates",
      category: null,
      status: "active",
      market_type: "binary",
      yes_bid: 0.1,
      yes_ask: 0.2,
      yes_last: 0.15,
      no_bid: null,
      no_ask: null,
      volume: 1,
      volume_24h: 10,
      open_interest: null,
      liquidity: null,
      floor_strike: null,
      close_time: "2026-09-01T00:00:00Z",
      expiration_time: null,
      related_symbol: "TLT",
      source: "kalshi",
    };
    const ranked = rankKalshiMarkets([
      { ...base, market_ticker: "LOW", volume_24h: 1, close_time: "2026-08-01T00:00:00Z" },
      { ...base, market_ticker: "HIGH", volume_24h: 99, close_time: "2026-12-01T00:00:00Z" },
      { ...base, market_ticker: "MID", volume_24h: 10, close_time: "2026-08-15T00:00:00Z" },
    ]);
    expect(ranked.map((r) => r.market_ticker)).toEqual(["HIGH", "MID", "LOW"]);
  });

  it("applySeriesCategory denormalizes category onto rows", () => {
    const rows = parseKalshiMarketsPayload("KXFED", { markets: [SAMPLE_MARKET] });
    const enriched = applySeriesCategory(rows, { series: { category: "Economics" } });
    expect(enriched[0].category).toBe("Economics");
  });

  it("normalizeKalshiRecords keeps schema fields and provenance", () => {
    const rows = parseKalshiMarketsPayload("KXFED", { markets: [SAMPLE_MARKET] });
    const out = normalizeKalshiRecords(rows, "run-1", "2026-08-22T00:00:00.000Z");
    expect(out[0].run_id).toBe("run-1");
    expect(out[0].fetched_at).toBe("2026-08-22T00:00:00.000Z");
    expect(out[0].market_ticker).toBe("KXFED-27APR-T4.25");
  });

  it("kalshiSeriesList exposes the curated allowlist", () => {
    const list = kalshiSeriesList();
    expect(list).toContain("KXFED");
    expect(list).toContain("KXCPI");
    expect(list).toContain("KXINX");
    expect(list).toContain("KXBTC");
    expect(list).not.toContain("KXSPORTS");
  });
});

describe("publishKalshiSeries", () => {
  it("requires PIPELINE_KALSHI_MARKETS_URL", async () => {
    await expect(publishKalshiSeries("KXFED")).rejects.toThrow(/PIPELINE_KALSHI_MARKETS_URL/);
  });

  it("fetches open markets, caps, and posts to the pipeline", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/series/KXFED")) {
        return new Response(JSON.stringify({ series: { category: "Economics", ticker: "KXFED" } }), {
          status: 200,
        });
      }
      if (url.includes("/markets?") && url.includes("series_ticker=KXFED")) {
        return new Response(JSON.stringify({ markets: [SAMPLE_MARKET], cursor: "" }), { status: 200 });
      }
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    try {
      const result = await publishKalshiSeries("KXFED", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_FETCH_SERIES_META: "1",
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        runId: () => "run-kalshi",
      });
      expect(result.published).toBe(true);
      expect(result.row_count).toBe(1);
      expect(result.run_id).toBe("run-kalshi");
      expect(posts).toHaveLength(1);
      const body = posts[0] as Array<Record<string, unknown>>;
      expect(body[0].category).toBe("Economics");
      expect(body[0].source).toBe("kalshi");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips publish when a series has no open markets", async () => {
    let posted = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/series/")) {
        return new Response(JSON.stringify({ series: { category: "Economics" } }), { status: 200 });
      }
      if (url.includes("/markets?")) {
        return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
      }
      if (init?.method === "POST") {
        posted += 1;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    try {
      const result = await publishKalshiSeries("KXFED", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        runId: () => "run-empty",
      });
      expect(result.published).toBe(false);
      expect(result.row_count).toBe(0);
      expect(posted).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
