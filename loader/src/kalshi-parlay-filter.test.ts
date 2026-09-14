import { describe, expect, it } from "vitest";
import {
  evaluateParlayQuote,
  parlayExecuteEnabled,
  parlayLiveEnabled,
  parlayMaxAcceptsPerPass,
  PARLAY_MIN_CORR_ROOM,
} from "./kalshi-parlay-filter.js";

describe("parlay execute flags", () => {
  it("requires both flags for live accepts", () => {
    expect(parlayExecuteEnabled({})).toBe(false);
    expect(parlayLiveEnabled({ KALSHI_PARLAY_EXECUTE: "1" })).toBe(false);
    expect(parlayLiveEnabled({
      KALSHI_PARLAY_EXECUTE: "1",
      KALSHI_PARLAY_LIVE: "1",
    })).toBe(true);
  });

  it("defaults live size to one $10 notional fill per pass", () => {
    expect(parlayMaxAcceptsPerPass({})).toBe(1);
    expect(parlayMaxAcceptsPerPass({ KALSHI_PARLAY_MAX_ACCEPTS_PER_PASS: 3 })).toBe(3);
    expect(parlayMaxAcceptsPerPass({ KALSHI_PARLAY_MAX_ACCEPTS_PER_PASS: "0" })).toBe(1);
    expect(parlayMaxAcceptsPerPass({ KALSHI_PARLAY_MAX_ACCEPTS_PER_PASS: 99 })).toBe(12);
  });
});

describe("evaluateParlayQuote", () => {
  it("buys Ferguson/Dart unders when the RFQ ask sits on p×q", () => {
    const decision = evaluateParlayQuote({
      market_ticker: "FERGUSON-DART",
      same_game: true,
      sides: ["no", "no"],
      p: 0.63,
      q: 0.715,
      yes_bid: 0.416,
      yes_ask: 0.451,
      quote_id: "q-ferg",
    });
    expect(decision.corr_room).toBeGreaterThan(PARLAY_MIN_CORR_ROOM);
    expect(decision.ok).toBe(true);
    expect(decision.action).toBe("buy_yes");
    expect(decision.reasons).toEqual([]);
  });

  it("skips mixed yes/no even when the ask is near independence", () => {
    const decision = evaluateParlayQuote({
      market_ticker: "PICKENS-SKATTEBO",
      same_game: true,
      sides: ["no", "yes"],
      p: 0.525,
      q: 0.235,
      yes_bid: 0.102,
      yes_ask: 0.121,
      quote_id: "q-mix",
    });
    expect(decision.ok).toBe(false);
    expect(decision.reasons).toContain("mixed_side");
  });

  it("skips a quote already charging correlation (ask far above p×q)", () => {
    const decision = evaluateParlayQuote({
      market_ticker: "DART-WILLIAMS",
      same_game: true,
      sides: ["yes", "no"],
      p: 0.47,
      q: 0.71,
      yes_bid: 0.484,
      yes_ask: 0.536,
      quote_id: "q-rho",
    });
    expect(decision.ok).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(["mixed_side", "ask_vs_indep"]));
  });

  it("skips wide two-ways, cross-game, n≠2, and synthetic books with no quote id", () => {
    expect(evaluateParlayQuote({
      market_ticker: "WIDE",
      same_game: true,
      sides: ["yes", "yes"],
      p: 0.40,
      q: 0.49,
      yes_bid: 0.10,
      yes_ask: 0.21,
      quote_id: "q-wide",
    }).reasons).toContain("spread");

    expect(evaluateParlayQuote({
      market_ticker: "CROSS",
      same_game: false,
      sides: ["yes", "yes"],
      p: 0.40,
      q: 0.49,
      yes_bid: 0.18,
      yes_ask: 0.20,
      quote_id: "q-cross",
    }).reasons).toContain("not_same_game");

    expect(evaluateParlayQuote({
      market_ticker: "SYNTH",
      same_game: true,
      sides: ["yes", "yes"],
      p: 0.40,
      q: 0.49,
      yes_bid: 0.18,
      yes_ask: 0.20,
      quote_id: null,
    }).reasons).toContain("no_quote_id");
  });
});
