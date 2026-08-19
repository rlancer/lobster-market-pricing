import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isBundledUniverseTicker,
  isEnrollableEquityTicker,
  shouldEnrollForMissingLakeData,
  enrollTickerWithLoader,
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
    const fetchImpl: typeof fetch = async (input, init) => {
      calledUrl = String(input);
      auth = String((init?.headers as Record<string, string>)?.Authorization || "");
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
      { source: "test", fetchImpl },
    );
    assert.equal(result?.symbol, "SOFI");
    assert.equal(result?.enrolled, true);
    assert.equal(calledUrl, "https://loader.test/symbols/enroll");
    assert.equal(auth, "Bearer sekrit");
  });

  it("returns null when LOADER_TOKEN is missing", async () => {
    const result = await enrollTickerWithLoader({}, "SOFI");
    assert.equal(result, null);
  });
});
