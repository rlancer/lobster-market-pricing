import { describe, expect, it } from "vitest";
import {
  evaluateParlayExecutorQuote,
  evaluateParlayQuote,
  parlayBook,
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

  it("defaults live size to one fill per pass", () => {
    expect(parlayMaxAcceptsPerPass({})).toBe(1);
    expect(parlayMaxAcceptsPerPass({ KALSHI_PARLAY_MAX_ACCEPTS_PER_PASS: 3 })).toBe(3);
    expect(parlayMaxAcceptsPerPass({ KALSHI_PARLAY_MAX_ACCEPTS_PER_PASS: "0" })).toBe(1);
    expect(parlayMaxAcceptsPerPass({ KALSHI_PARLAY_MAX_ACCEPTS_PER_PASS: 99 })).toBe(12);
  });

  it("defaults the executable book to same-game underdog YES", () => {
    expect(parlayBook({})).toBe("same_game_underdog");
    expect(parlayBook({ KALSHI_PARLAY_BOOK: "corr_room_yes" })).toBe("corr_room_yes");
    expect(parlayBook({ KALSHI_PARLAY_BOOK: "cross_game_longshot" })).toBe("cross_game_longshot");
    expect(parlayBook({ KALSHI_PARLAY_BOOK: "longshot" })).toBe("cross_game_longshot");
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

describe("evaluateUnderdogYesQuote", () => {
  it("takes a same-game YES ask at 41¢ even when the quote is already at Fréchet", () => {
    const decision = evaluateParlayExecutorQuote({
      market_ticker: "FRECHET",
      same_game: true,
      sides: ["yes", "yes"],
      p: 0.40,
      q: 0.49,
      yes_bid: 0.38,
      yes_ask: 0.41,
      quote_id: "q-rho",
    }, "same_game_underdog");
    expect(decision.ok).toBe(true);
    expect(decision.action).toBe("buy_yes");
    expect(evaluateParlayQuote({
      market_ticker: "FRECHET",
      same_game: true,
      sides: ["yes", "yes"],
      p: 0.40,
      q: 0.49,
      yes_bid: 0.38,
      yes_ask: 0.41,
      quote_id: "q-rho",
    }).ok).toBe(false);
  });

  it("skips YES asks above 50¢", () => {
    const decision = evaluateParlayExecutorQuote({
      market_ticker: "FAVORITE",
      same_game: true,
      sides: ["yes", "yes"],
      p: 0.80,
      q: 0.80,
      yes_bid: 0.58,
      yes_ask: 0.62,
      quote_id: "q-fav",
    }, "same_game_underdog");
    expect(decision.ok).toBe(false);
    expect(decision.reasons).toContain("underdog_cost");
  });
});

describe("evaluateLongshotYesQuote", () => {
  const kcTb = {
    market_ticker: "KC-TB-SPREAD",
    same_game: false,
    cross_game: true,
    sides: ["yes", "yes"] as Array<"yes" | "no">,
    p: 0.48,
    q: 0.16,
    quote_id: "q-combo",
  };

  it("takes the Kalshi 2-market combo that pays 37x below independence", () => {
    const ask = 119.99 / 4493;
    const decision = evaluateParlayExecutorQuote({
      ...kcTb,
      yes_bid: 0.02,
      yes_ask: ask,
    }, "cross_game_longshot");
    expect(decision.ok).toBe(true);
    expect(decision.action).toBe("buy_yes");
    expect(decision.payout_multiple).toBeCloseTo(37.45, 1);
    expect(decision.independence).toBeCloseTo(0.0768, 4);
    expect(decision.ask_vs_indep).toBeLessThan(0);
  });

  it("skips a 25x card that does not clear 35x", () => {
    const ask = 89.97 / 2278;
    const decision = evaluateParlayExecutorQuote({
      ...kcTb,
      yes_bid: 0.03,
      yes_ask: ask,
    }, "cross_game_longshot");
    expect(decision.ok).toBe(false);
    expect(decision.reasons).toContain("payout");
    expect(decision.payout_multiple).toBeCloseTo(25.3, 1);
  });

  it("skips a 50¢ same-game underdog and a quote above independence", () => {
    expect(evaluateParlayExecutorQuote({
      market_ticker: "SAME",
      same_game: true,
      cross_game: false,
      sides: ["yes", "yes"],
      p: 0.48,
      q: 0.16,
      yes_bid: 0.02,
      yes_ask: 0.0267,
      quote_id: "q-same",
    }, "cross_game_longshot").reasons).toContain("not_cross_game");

    expect(evaluateParlayExecutorQuote({
      ...kcTb,
      yes_bid: 0.08,
      yes_ask: 0.09,
    }, "cross_game_longshot").reasons).toEqual(expect.arrayContaining(["payout", "ask_vs_indep"]));
  });
});
