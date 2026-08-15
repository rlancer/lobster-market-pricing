import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzePriceAction, parseTickerParam, summarizeResearch, type OhlcBar, type TickerResearch } from "../src/research";
import { identityFromOpenFigi, identityFromTicker } from "../src/figi";
import { normalizeTicker, securityIdForTicker } from "../src/symbology";

function bar(date: string, close: number, volume: number, high?: number, low?: number): OhlcBar {
  return {
    date,
    open: close,
    high: high ?? close * 1.01,
    low: low ?? close * 0.99,
    close,
    volume,
  };
}

describe("symbology", () => {
  it("normalizes and seeds stable security ids", () => {
    assert.equal(normalizeTicker(" aapl "), "AAPL");
    assert.equal(securityIdForTicker("AAPL"), securityIdForTicker("aapl"));
    assert.notEqual(securityIdForTicker("AAPL"), securityIdForTicker("MSFT"));
  });
});

describe("figi identity", () => {
  it("prefers OpenFIGI canonical ticker while keeping ticker-seeded security_id", () => {
    const id = identityFromOpenFigi("META", {
      ticker: "META",
      figi: "BBG000BPH459",
      compositeFIGI: "BBG000BPH459",
      name: "Meta Platforms Inc",
      exchCode: "US",
    }, 1_700_000_000_000);
    assert.equal(id.ticker, "META");
    assert.equal(id.security_id, securityIdForTicker("META"));
    assert.equal(id.figi, "BBG000BPH459");
    assert.equal(id.source, "openfigi");
  });

  it("falls back to ticker identity", () => {
    const id = identityFromTicker("nvda", 1);
    assert.equal(id.ticker, "NVDA");
    assert.equal(id.source, "ticker");
    assert.equal(id.figi, null);
  });
});

describe("analyzePriceAction", () => {
  it("flags consolidation and accumulation on a tight rising range", () => {
    const bars: OhlcBar[] = [];
    for (let i = 0; i < 30; i++) {
      const close = 100 + i * 0.05;
      bars.push(bar(`2026-01-${String(i + 1).padStart(2, "0")}`, close, 1_000_000 + i * 50_000, close + 0.2, close - 0.2));
    }
    const { price, technicals } = analyzePriceAction(bars);
    assert.ok(price.spot != null);
    assert.equal(technicals.consolidation, true);
    assert.ok(technicals.consolidation_range_pct != null && technicals.consolidation_range_pct <= 8);
    assert.equal(technicals.accumulation, "accumulating");
    assert.ok(technicals.notes.length >= 1);
  });

  it("detects distribution on falling closes with volume", () => {
    const bars: OhlcBar[] = [];
    for (let i = 0; i < 25; i++) {
      const close = 100 - i * 0.4;
      bars.push(bar(`2026-02-${String(i + 1).padStart(2, "0")}`, close, 2_000_000, close + 1, close - 1));
    }
    const { technicals, price } = analyzePriceAction(bars);
    assert.ok((price.change_21d_pct ?? 0) < 0);
    assert.equal(technicals.accumulation, "distributing");
    assert.equal(technicals.trend, "down");
  });
});

describe("parseTickerParam", () => {
  it("accepts exchange tickers and rejects junk", () => {
    assert.equal(parseTickerParam("aapl"), "AAPL");
    assert.equal(parseTickerParam("BRK.B"), "BRK.B");
    assert.equal(parseTickerParam(""), null);
    assert.equal(parseTickerParam("!!!"), null);
  });
});

describe("summarizeResearch", () => {
  it("renders a compact tool summary", () => {
    const research: TickerResearch = {
      identity: {
        security_id: securityIdForTicker("AAPL"),
        ticker: "AAPL",
        figi: "BBG000B9XRY4",
        composite_figi: "BBG000B9XRY4",
        isin: null,
        name: "Apple Inc",
        exchange: "US",
        currency: "USD",
        sector: "Equity",
        source: "openfigi",
        resolved_at: 1,
      },
      price: {
        spot: 190,
        change_1d_pct: 1.2,
        change_5d_pct: 3.4,
        change_21d_pct: -2.1,
        change_63d_pct: 8,
        high_63d: 200,
        low_63d: 170,
        volume_latest: 80_000_000,
        volume_avg_20d: 60_000_000,
        volume_relative_20d: 80_000_000 / 60_000_000,
      },
      technicals: {
        trend: "up",
        consolidation: false,
        consolidation_range_pct: 12,
        accumulation: "neutral",
        notes: ["No strong consolidation or volume skew in the recent window."],
      },
      realized_vol: null,
      fundamentals: {
        market_cap: 3e12,
        enterprise_value: null,
        trailing_pe: 30,
        forward_pe: 28,
        peg_ratio: null,
        price_to_book: null,
        total_debt: 1e11,
        debt_to_equity: 150,
        profit_margins: 0.25,
        revenue_growth: null,
        source: "yahoo",
      },
      earnings: [{ earnings_date: "2026-07-30", time: "after-hours", fiscal_q: "Jun/2026", eps_forecast: 1.4, last_year_eps: 1.2, name: "Apple" }],
      news: [{ title: "Apple headlines", link: "https://example.com" }],
      etf: null,
      computed_at: "2026-08-15T00:00:00.000Z",
      expires_at: "2026-08-15T01:00:00.000Z",
      cache_hit: false,
    };
    const text = summarizeResearch(research);
    assert.match(text, /AAPL/);
    assert.match(text, /figi=BBG000B9XRY4/);
    assert.match(text, /marketCap=/);
    assert.match(text, /Apple headlines/);
  });
});
