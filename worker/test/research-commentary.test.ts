import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMMENTARY_SYSTEM,
  formatTradeIdea,
  looksLikeStructuredCommentary,
  suggestTradeIdea,
  synthesizeCommentary,
} from "../src/research-commentary";
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

describe("COMMENTARY_SYSTEM", () => {
  it("requires directional bias, options structure, and Markdown paragraphs", () => {
    assert.match(COMMENTARY_SYSTEM, /bullish|bearish|neutral/i);
    assert.match(COMMENTARY_SYSTEM, /options structure|Trade section/i);
    assert.match(COMMENTARY_SYSTEM, /conviction is low/i);
    assert.match(COMMENTARY_SYSTEM, /Markdown/i);
    assert.match(COMMENTARY_SYSTEM, /blank lines|short paragraphs/i);
    assert.match(COMMENTARY_SYSTEM, /\*\*Trade/);
    assert.match(COMMENTARY_SYSTEM, /tradable|liquidity|volume looks weak/i);
  });
});

describe("suggestTradeIdea", () => {
  it("leans bullish on uptrend + accumulation and suggests call structure", () => {
    const idea = suggestTradeIdea(sampleResearch());
    assert.equal(idea.bias, "bullish");
    assert.match(idea.structure, /call/i);
    assert.match(formatTradeIdea(idea), /Bullish/);
  });

  it("leans bearish on downtrend + distribution", () => {
    const idea = suggestTradeIdea(sampleResearch({
      price: {
        spot: 90,
        change_1d_pct: -2,
        change_5d_pct: -6,
        change_21d_pct: -12,
        change_63d_pct: -20,
        high_63d: 120,
        low_63d: 85,
        volume_latest: 40_000_000,
        volume_avg_20d: 50_000_000,
        volume_relative_20d: 0.8,
      },
      technicals: {
        trend: "down",
        consolidation: false,
        consolidation_range_pct: 14,
        accumulation: "distributing",
        notes: ["SMA20 below SMA50 — intermediate downtrend bias."],
      },
      earnings: [],
    }));
    assert.equal(idea.bias, "bearish");
    assert.match(idea.structure, /put/i);
  });

  it("stays neutral in consolidation without a directional lean and still suggests a trade", () => {
    const idea = suggestTradeIdea(sampleResearch({
      price: {
        spot: 100,
        change_1d_pct: 0.1,
        change_5d_pct: 0.5,
        change_21d_pct: 1,
        change_63d_pct: 2,
        high_63d: 105,
        low_63d: 95,
        volume_latest: 10_000_000,
        volume_avg_20d: 12_000_000,
        volume_relative_20d: 0.8,
      },
      technicals: {
        trend: "sideways",
        consolidation: true,
        consolidation_range_pct: 4,
        accumulation: "neutral",
        notes: ["20-session range is tight (4.0% of mid) — consolidation."],
      },
      earnings: [],
    }));
    assert.equal(idea.bias, "neutral");
    assert.match(idea.structure, /condor|straddle|calendar/i);
  });

  it("still suggests a trade when the brief is thin", () => {
    const idea = suggestTradeIdea(sampleResearch({
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
    assert.equal(idea.conviction, "low");
    assert.ok(idea.structure.length > 10);
    assert.match(formatTradeIdea(idea), /low conviction/i);
  });

  it("flags defined-risk structures near earnings", () => {
    const idea = suggestTradeIdea(sampleResearch({
      computed_at: "2026-08-10T00:00:00.000Z",
      earnings: [{
        earnings_date: "2026-08-20",
        time: "after-hours",
        fiscal_q: "Jun/2026",
        eps_forecast: 1.4,
        last_year_eps: 1.2,
        name: "Apple",
      }],
    }));
    assert.match(idea.structure, /defined-risk|event|earnings|crush/i);
  });
});

describe("synthesizeCommentary", () => {
  it("leads with spot and closes with a Markdown Trade section", () => {
    const text = synthesizeCommentary(sampleResearch());
    assert.match(text, /AAPL marks 190\.25/);
    assert.match(text, /\+1\.2% 1d/);
    assert.match(text, /up trend/);
    assert.match(text, /consolidating/);
    assert.match(text, /trailing P\/E/);
    assert.match(text, /\*\*Trade — Bullish/);
    assert.match(text, /call/i);
    assert.ok(looksLikeStructuredCommentary(text));
    assert.ok(text.includes("\n\n"));
  });

  it("handles missing spot without throwing and still suggests a trade", () => {
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
    assert.match(text, /low conviction/i);
    assert.match(text, /\b(call|put|condor)\b/i);
    assert.ok(looksLikeStructuredCommentary(text));
  });
});

describe("looksLikeStructuredCommentary", () => {
  it("rejects legacy single-line trade blurbs", () => {
    assert.equal(
      looksLikeStructuredCommentary("AAPL marks 190. Bullish (medium conviction): call debit ~30 DTE."),
      false,
    );
  });

  it("accepts multi-line Markdown with a Trade header", () => {
    assert.equal(
      looksLikeStructuredCommentary("AAPL marks 190.\n\n**Trade — Bullish (medium conviction)**\nCall debit ~30 DTE."),
      true,
    );
  });
});
