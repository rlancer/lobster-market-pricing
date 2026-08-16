import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { synthesizeCommentary } from "../src/research-commentary";
import type { TickerResearch } from "../src/research";
import { securityIdForTicker } from "../src/symbology";

function sampleResearch(over: Partial<TickerResearch> = {}): TickerResearch {
  return {
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
      spot: 190.25,
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
      consolidation: true,
      consolidation_range_pct: 5.2,
      accumulation: "accumulating",
      notes: ["20-session range is tight (5.2% of mid) — consolidation."],
    },
    realized_vol: null,
    fundamentals: {
      market_cap: 3e12,
      enterprise_value: null,
      trailing_pe: 30.1,
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
    ...over,
  };
}

describe("synthesizeCommentary", () => {
  it("leads with spot and 1d move", () => {
    const text = synthesizeCommentary(sampleResearch());
    assert.match(text, /AAPL marks 190\.25/);
    assert.match(text, /\+1\.2% 1d/);
    assert.match(text, /up trend/);
    assert.match(text, /consolidating/);
    assert.match(text, /trailing P\/E/);
  });

  it("handles missing spot without throwing", () => {
    const text = synthesizeCommentary(sampleResearch({
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
        notes: ["No strong consolidation or volume skew in the recent window."],
      },
      fundamentals: {
        market_cap: null,
        enterprise_value: null,
        trailing_pe: null,
        forward_pe: null,
        peg_ratio: null,
        price_to_book: null,
        total_debt: null,
        debt_to_equity: null,
        profit_margins: null,
        revenue_growth: null,
        source: null,
      },
      earnings: [],
    }));
    assert.match(text, /no lake spot yet/i);
  });
});
