import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isBundledUniverseTicker,
  isEnrollableEquityTicker,
  shouldEnrollForMissingLakeData,
  enrollTickerWithLoader,
  maybeEnrollIdentifiedFund,
} from "../src/enroll-symbol";
import { emptyFundamentals, type TickerResearch } from "../src/research";

function thinResearch(ticker: string): TickerResearch {
  return {
    identity: {
      ticker,
      security_id: "x",
      name: null,
      sector: null,
      exchange: null,
      currency: null,
      figi: null,
      composite_figi: null,
      isin: null,
      source: "ticker",
      resolved_at: Date.now(),
    },
    price: {
      spot: null,
      change_1d_pct: null,
      change_5d_pct: null,
      change_21d_pct: null,
      change_63d_pct: null,
      high_63d: null,
      low_63d: null,
      volume_latest: null,
      volume_avg_20d: null,
      volume_relative_20d: null,
    },
    technicals: {
      trend: "unknown",
      consolidation: false,
      consolidation_range_pct: null,
      accumulation: "unknown",
      notes: [],
    },
    realized_vol: null,
    fundamentals: emptyFundamentals(),
    earnings: [],
    news: [],
    etf: null,
    commentary: null,
    commentary_source: null,
    computed_at: new Date().toISOString(),
    expires_at: new Date().toISOString(),
    cache_hit: false,
  };
}

describe("enroll-symbol", () => {
  it("detects enrollable equities and bundled membership", () => {
    assert.equal(isEnrollableEquityTicker("sofi"), true);
    assert.equal(isEnrollableEquityTicker("^VIX"), false);
    assert.equal(isEnrollableEquityTicker("BTC-USD"), false);
    assert.equal(isBundledUniverseTicker("AAPL"), true);
    assert.equal(isBundledUniverseTicker("SOFI"), false);
    assert.equal(isBundledUniverseTicker("IBIT"), true);
  });

  it("enrolls only thin, out-of-universe equities", () => {
    assert.equal(shouldEnrollForMissingLakeData(thinResearch("SOFI")), true);
    assert.equal(shouldEnrollForMissingLakeData(thinResearch("AAPL")), false);
    assert.equal(shouldEnrollForMissingLakeData(thinResearch("^VIX")), false);
    assert.equal(shouldEnrollForMissingLakeData(thinResearch("BTC-USD")), false);
  });

  it("POSTs to the loader enroll endpoint when LOADER_TOKEN is set", async () => {
    let calledUrl = "";
    let auth = "";
    let posted: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      calledUrl = String(input);
      auth = String((init?.headers as Record<string, string>)?.Authorization || "");
      posted = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          symbol: "SOFI",
          enrolled: true,
          already: false,
          bundled: false,
          enabled: true,
          load_now: true,
        }),
        { status: 200 },
      );
    };
    const result = await enrollTickerWithLoader(
      { LOADER_TOKEN: "sekrit", LOADER_BASE_URL: "https://loader.test" },
      "sofi",
      { source: "test", fetchImpl, securityType: "etf" },
    );
    assert.equal(result?.symbol, "SOFI");
    assert.equal(result?.enrolled, true);
    assert.equal(calledUrl, "https://loader.test/symbols/enroll");
    assert.equal(auth, "Bearer sekrit");
    assert.equal(posted.security_type, "etf");
  });

  it("returns null when LOADER_TOKEN is missing", async () => {
    const result = await enrollTickerWithLoader({}, "SOFI");
    assert.equal(result, null);
  });

  it("enrolls looked-up ETFs that are outside the bundled universe", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      posts.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({
        symbol: "RSP",
        enrolled: true,
        already: false,
        bundled: false,
        enabled: true,
      }), { status: 200 });
    };
    const pending: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => { pending.push(p); };
    maybeEnrollIdentifiedFund(
      { LOADER_TOKEN: "sekrit", LOADER_BASE_URL: "https://loader.test" },
      { symbol: "RSP", name: "Invesco S&P 500 Equal Weight ETF", kind: "etf", source: "yahoo" },
      { source: "test", fetchImpl, waitUntil },
    );
    maybeEnrollIdentifiedFund(
      { LOADER_TOKEN: "sekrit", LOADER_BASE_URL: "https://loader.test" },
      { symbol: "SPY", name: "SPDR S&P 500", kind: "etf", source: "yahoo" },
      { source: "test", fetchImpl, waitUntil },
    );
    maybeEnrollIdentifiedFund(
      { LOADER_TOKEN: "sekrit", LOADER_BASE_URL: "https://loader.test" },
      { symbol: "AAPL", name: "Apple", kind: "equity", source: "yahoo" },
      { source: "test", fetchImpl, waitUntil },
    );
    await Promise.all(pending);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.symbol, "RSP");
    assert.equal(posts[0]!.security_type, "etf");
    assert.equal(posts[0]!.etl_scope, "etf");
    assert.equal(posts[0]!.load_now, false);
  });
});
