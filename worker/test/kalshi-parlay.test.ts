import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bernoulliPhi,
  bivNormCdf,
  clampProb,
  extractPeriod,
  frechetLower,
  frechetUpper,
  gaussianCopulaJoint,
  impliedGaussianRho,
  independenceJoint,
  logReturns,
  normCdf,
  normInv,
  parseDecisionTicker,
  parseDissentCountTicker,
  parseFedComboTicker,
  parseKalshiNumber,
  pearsonCorrelation,
  quoteMid,
  quoteSpread,
  encodeMveCategory,
  parseMveCategory,
  hasTradableQuote,
  listedComboMid,
  kalshiTakerFee,
  mveLegKind,
  mveTapeKind,
  scoreMultiLegParlay,
  scoreTwoLegParlay,
  sportsGameKey,
} from "../src/kalshi-parlay";
import {
  buildCorrelations,
  buildSportsRows,
  buildVerdict,
  isLiveQuote,
  kalshiParlayCacheTtlMs,
  mapKalshiMarket,
  runKalshiParlayExperiment,
  censusFromLakeMarkets,
  scoreMveParlays,
  toQuoteView,
  type LakeKalshiMarket,
} from "../src/kalshi-parlay-experiment";
import { backtestParlayStrategy } from "../src/kalshi-parlay-backtest";

describe("parseKalshiNumber + quoteMid", () => {
  it("parses dollar strings and numbers", () => {
    assert.equal(parseKalshiNumber("0.6100"), 0.61);
    assert.equal(parseKalshiNumber(0.22), 0.22);
    assert.equal(parseKalshiNumber(""), null);
  });

  it("uses bid/ask mid unless the book is 0/1", () => {
    assert.equal(quoteMid({ yes_bid: 0.61, yes_ask: 0.62, yes_last: 0.5 }), 0.615);
    assert.equal(quoteMid({ yes_bid: 0, yes_ask: 1, yes_last: 0.4 }), 0.4);
    assert.equal(quoteMid({ yes_bid: 0, yes_ask: 1, yes_last: 0 }), null);
    assert.equal(quoteSpread({ yes_bid: 0.61, yes_ask: 0.62 }), 0.01);
  });

  it("does not treat RFQ 0/0/0 as a listed mid", () => {
    assert.equal(quoteMid({ yes_bid: 0, yes_ask: 0, yes_last: 0 }), null);
    assert.equal(listedComboMid({ yes_bid: 0, yes_ask: 0, yes_last: 0 }), null);
    assert.equal(listedComboMid({ yes_bid: 0, yes_ask: 1, yes_last: 0 }), null);
    assert.equal(listedComboMid({ yes_bid: 0.20, yes_ask: 0.24, yes_last: 0.22 }), 0.22);
    assert.equal(listedComboMid({ yes_bid: 0, yes_ask: 0, yes_last: 0.22 }), null);
    assert.equal(listedComboMid({ yes_bid: 0, yes_ask: 0, yes_last: 0.50, volume: 0 }), null);
    assert.equal(listedComboMid({ yes_bid: 0, yes_ask: 0, yes_last: 0.22, volume: 12 }), 0.22);
  });

  it("treats settlement 0/1 as not tradable and a 0.22 mid as tradable", () => {
    assert.equal(hasTradableQuote({ yes_bid: 1, yes_ask: 1, yes_last: 1 }), false);
    assert.equal(hasTradableQuote({ yes_bid: 0, yes_ask: 0, yes_last: 0 }), false);
    assert.equal(hasTradableQuote({ yes_bid: 0.18, yes_ask: 0.22, yes_last: 0.20 }), true);
  });
});

describe("Fed combo tickers", () => {
  it("parses KXFEDCOMBO-26SEPB-25H-T0", () => {
    const parsed = parseFedComboTicker("KXFEDCOMBO-26SEPB-25H-T0");
    assert.deepEqual(parsed, {
      ticker: "KXFEDCOMBO-26SEPB-25H-T0",
      period: "26SEP",
      rate: "hike_25",
      dissent: "some",
    });
  });

  it("parses hold + unanimous without the B suffix", () => {
    const parsed = parseFedComboTicker("kxfedcombo-26jul-0-0");
    assert.equal(parsed?.period, "26JUL");
    assert.equal(parsed?.rate, "hold");
    assert.equal(parsed?.dissent, "zero");
  });

  it("maps decision and dissent-count tickers onto the same period", () => {
    assert.equal(parseDecisionTicker("KXFEDDECISION-26SEP-H25")?.rate, "hike_25");
    assert.equal(parseDecisionTicker("KXFEDDECISION-26SEP-H0")?.rate, "hold");
    assert.equal(parseDissentCountTicker("KXFOMCDISSENTCOUNT-26SEP-0")?.count, 0);
    assert.equal(extractPeriod("KXFEDCOMBO-26SEPB-25H-T0"), "26SEP");
  });

  it("rejects junk", () => {
    assert.equal(parseFedComboTicker("KXBTC-26SEP-T1"), null);
    assert.equal(parseDecisionTicker("KXFEDDECISION-26SEP-H26"), null);
  });
});

describe("independence, Fréchet, phi, Gaussian copula", () => {
  it("independence is the product", () => {
    assert.equal(independenceJoint([0.5, 0.4]), 0.2);
  });

  it("Fréchet bounds for two events", () => {
    assert.equal(frechetLower([0.8, 0.7]), 0.5);
    assert.equal(frechetUpper([0.8, 0.7]), 0.7);
    assert.equal(frechetLower([0.2, 0.2]), 0);
  });

  it("phi is zero under independence and positive when the joint is rich", () => {
    assert.ok(Math.abs(bernoulliPhi(0.5, 0.5, 0.25)!) < 1e-12);
    const phi = bernoulliPhi(0.795, 0.69, 0.615);
    assert.ok(phi != null && phi > 0.3);
  });

  it("Φ₂(0,0,ρ) = 1/4 + arcsin(ρ)/(2π)", () => {
    const expected = 0.25 + Math.asin(0.5) / (2 * Math.PI);
    const got = bivNormCdf(0, 0, 0.5);
    assert.ok(Math.abs(got - expected) < 1e-4, `got ${got} expected ${expected}`);
  });

  it("copula recovers independence and the Fréchet corners", () => {
    assert.ok(Math.abs(gaussianCopulaJoint(0.4, 0.6, 0) - 0.24) < 1e-4);
    assert.ok(Math.abs(gaussianCopulaJoint(0.4, 0.6, 0.999) - 0.4) < 0.01);
    assert.ok(Math.abs(gaussianCopulaJoint(0.4, 0.6, -0.999) - 0) < 0.01);
  });

  it("inverts implied ρ around a known copula joint", () => {
    const p = 0.5;
    const q = 0.5;
    const joint = gaussianCopulaJoint(p, q, 0.5);
    const implied = impliedGaussianRho(p, q, joint);
    assert.ok(implied != null && Math.abs(implied - 0.5) < 0.02, `implied ${implied}`);
  });

  it("normInv/normCdf round-trip at 0.5", () => {
    assert.ok(Math.abs(normInv(0.5)) < 1e-8);
    assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  });
});

describe("scoreMultiLegParlay + MVE category", () => {
  it("n-leg independence is the product", () => {
    const score = scoreMultiLegParlay({
      probs: [0.5, 0.4, 0.5],
      joint: 0.20,
      comboSpread: 0.02,
      legSpreads: [0.02, 0.02, 0.02],
    });
    assert.equal(score.independence, 0.1);
    assert.ok(score.gap_vs_independence != null && Math.abs(score.gap_vs_independence - 0.1) < 1e-9);
    assert.ok(score.flags.includes("independence_gap"));
    assert.equal(score.phi, null);
    assert.equal(score.implied_rho, null);
  });

  it("round-trips sports combo legs through category", () => {
    const packed = encodeMveCategory("KXMVESPORT-NFL", [
      { event_ticker: "A", market_ticker: "KXNFLGAME-1-KC", side: "yes" },
      { event_ticker: "B", market_ticker: "KXNFLGAME-1-BUF", side: "no" },
    ]);
    const parsed = parseMveCategory(packed);
    assert.equal(parsed?.collection, "KXMVESPORT-NFL");
    assert.equal(parsed?.legs[1]?.side, "no");
    assert.equal(parsed?.legs[0]?.event_ticker, "A");
    assert.equal(parsed?.legs[1]?.event_ticker, "B");
  });

  it("groups 1H spread and total on the same NFL game", () => {
    assert.equal(sportsGameKey("KXNFL1HSPREAD-26SEP13ATLPIT-PIT11"), "26SEP13ATLPIT");
    assert.equal(sportsGameKey("KXNFL1HTOTAL-26SEP13ATLPIT-25"), "26SEP13ATLPIT");
    assert.equal(mveTapeKind(["KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40"]), "sports");
    assert.equal(mveTapeKind(["KXBTC15M-26SEP131430-30", "KXETH15M-26SEP131430-30"]), "crypto_mve");
    assert.equal(mveTapeKind(["KXBTCD-26SEP1315-T77299.99", "KXSOLD-26SEP1315-T100.7499"]), "crypto_mve");
    assert.equal(mveLegKind("KXBTCD-26SEP1315-T77299.99"), "crypto");
    assert.equal(mveLegKind("KXSOLD-26SEP1315-T100.7499"), "crypto");
    assert.equal(mveTapeKind(["KXNFLGAME-26SEP13ATLPIT-PIT", "KXBTC15M-26SEP131430-30"]), "mixed");
    assert.ok(kalshiTakerFee(0.5) > 0.01 && kalshiTakerFee(0.5) < 0.02);
  });
});

describe("buildSportsRows", () => {
  it("flags same-game parlays and empty combo books", () => {
    const category = encodeMveCategory("KXMVESPORT-NFL", [
      { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-KC", side: "yes" },
      { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-OVER", side: "yes" },
    ]);
    const rows = buildSportsRows([
      {
        series_ticker: "KXNFLPARLAY",
        market_ticker: "KXNFLPARLAY-SGP",
        event_ticker: "KXNFLPARLAY-SGP",
        title: "Chiefs win AND over",
        yes_subtitle: null,
        theme: "sports",
        category,
        status: "active",
        market_type: "multivariate",
        yes_bid: 0,
        yes_ask: 1,
        yes_last: 0,
        volume: 0,
        close_time: "2026-09-14T00:00:00Z",
      },
      {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26SEP13KC-KC",
        event_ticker: "KXNFLGAME-26SEP13KC",
        title: "Chiefs win",
        yes_subtitle: "KC",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.55,
        yes_ask: 0.57,
        yes_last: 0.56,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
      },
      {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26SEP13KC-OVER",
        event_ticker: "KXNFLGAME-26SEP13KC",
        title: "Over 44.5",
        yes_subtitle: "Over",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.50,
        yes_ask: 0.52,
        yes_last: 0.51,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
      },
    ], Date.parse("2026-09-13T12:00:00Z"));
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.score.flags.includes("same_game"));
    assert.ok(rows[0]!.score.flags.includes("no_combo_tape"));
    assert.ok(rows[0]!.score.flags.includes("rfq_auction"));
    assert.equal(rows[0]!.score.joint, null);
    assert.equal(rows[0]!.score.flags.includes("independence_gap"), false);
    assert.ok(Math.abs(rows[0]!.score.independence - 0.56 * 0.51) < 1e-6);
    assert.ok(rows[0]!.score.corr_room > 0.2);
  });

  it("does not score RFQ 0/0/0 as an independence gap", () => {
    const category = encodeMveCategory("KXMVECROSSCATEGORY-SHARD1-R", [
      { event_ticker: "KXNFL1HSPREAD-26SEP13ATLPIT", market_ticker: "KXNFL1HSPREAD-26SEP13ATLPIT-PIT11", side: "no" },
      { event_ticker: "KXNFL1HTOTAL-26SEP13ATLPIT", market_ticker: "KXNFL1HTOTAL-26SEP13ATLPIT-25", side: "no" },
    ]);
    const rows = buildSportsRows([
      {
        series_ticker: "KXMVE",
        market_ticker: "KXMVECROSSCATEGORY-RFQ",
        event_ticker: null,
        title: "no PIT Steelers wins 1H by over 10.5 points,no Over 24.5 1H points scored",
        yes_subtitle: null,
        theme: "sports",
        category,
        status: "active",
        market_type: "multivariate",
        yes_bid: 0,
        yes_ask: 0,
        yes_last: 0,
        volume: 0,
        close_time: "2026-09-14T00:00:00Z",
        fetched_at: "2026-09-13T18:24:03.017Z",
      },
      {
        series_ticker: "KXNFL1HSPREAD",
        market_ticker: "KXNFL1HSPREAD-26SEP13ATLPIT-PIT11",
        event_ticker: "KXNFL1HSPREAD-26SEP13ATLPIT",
        title: "PIT 1H spread",
        yes_subtitle: "PIT Steelers wins 1H by over 10.5 points",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.30,
        yes_ask: 0.32,
        yes_last: 0.31,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
      },
      {
        series_ticker: "KXNFL1HTOTAL",
        market_ticker: "KXNFL1HTOTAL-26SEP13ATLPIT-25",
        event_ticker: "KXNFL1HTOTAL-26SEP13ATLPIT",
        title: "1H total",
        yes_subtitle: "Over 24.5 1H points scored",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.40,
        yes_ask: 0.42,
        yes_last: 0.41,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
      },
    ], Date.parse("2026-09-13T12:00:00Z"));
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.score.flags.includes("same_game"));
    assert.ok(rows[0]!.score.flags.includes("no_combo_tape"));
    assert.ok(rows[0]!.score.flags.includes("rfq_auction"));
    assert.equal(rows[0]!.score.joint, null);
    assert.equal(rows[0]!.score.gap_vs_independence, null);
    assert.equal(rows[0]!.score.flags.includes("independence_gap"), false);
    assert.equal(rows[0]!.score.flags.includes("below_frechet"), false);
    assert.match(rows[0]!.notes, /unpriced if the RFQ quotes/);
    assert.ok(rows[0]!.score.corr_room > 0.15);
  });

  it("scores an RFQ auction print on an empty resting book", () => {
    const category = encodeMveCategory("KXMVECROSSCATEGORY-SHARD1-R", [
      { event_ticker: "KXNFL1HSPREAD-26SEP13ATLPIT", market_ticker: "KXNFL1HSPREAD-26SEP13ATLPIT-PIT11", side: "no" },
      { event_ticker: "KXNFL1HTOTAL-26SEP13ATLPIT", market_ticker: "KXNFL1HTOTAL-26SEP13ATLPIT-25", side: "no" },
    ]);
    const rows = buildSportsRows([
      {
        series_ticker: "KXMVE",
        market_ticker: "KXMVECROSSCATEGORY-AUCTIONPRINT",
        event_ticker: null,
        title: "no PIT Steelers wins 1H by over 10.5 points,no Over 24.5 1H points scored",
        yes_subtitle: null,
        theme: "sports",
        category,
        status: "active",
        market_type: "multivariate",
        yes_bid: 0,
        yes_ask: 0,
        yes_last: 0.22,
        volume: 12,
        close_time: "2026-09-14T00:00:00Z",
        fetched_at: "2026-09-13T18:24:03.017Z",
      },
      {
        series_ticker: "KXNFL1HSPREAD",
        market_ticker: "KXNFL1HSPREAD-26SEP13ATLPIT-PIT11",
        event_ticker: "KXNFL1HSPREAD-26SEP13ATLPIT",
        title: "PIT 1H spread",
        yes_subtitle: "PIT Steelers wins 1H by over 10.5 points",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.38,
        yes_ask: 0.40,
        yes_last: 0.39,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
      },
      {
        series_ticker: "KXNFL1HTOTAL",
        market_ticker: "KXNFL1HTOTAL-26SEP13ATLPIT-25",
        event_ticker: "KXNFL1HTOTAL-26SEP13ATLPIT",
        title: "1H total",
        yes_subtitle: "Over 24.5 1H points scored",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.40,
        yes_ask: 0.42,
        yes_last: 0.41,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
      },
    ], Date.parse("2026-09-13T12:00:00Z"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.score.joint, 0.22);
    assert.ok(rows[0]!.score.flags.includes("rfq_auction_print"));
    assert.equal(rows[0]!.score.flags.includes("no_combo_tape"), false);
    assert.match(rows[0]!.notes, /auction print/);
  });

  it("scores a solicited RFQ two-way and flags ignores_correlation when the quote is p×q", () => {
    const category = encodeMveCategory("KXMVECROSSCATEGORY-SHARD1-R", [
      { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", side: "yes" },
      { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", side: "yes" },
    ]);
    const rows = buildSportsRows([
      {
        series_ticker: "KXMVE",
        market_ticker: "KXMVECROSSCATEGORY-RFQQUOTE",
        event_ticker: null,
        title: "yes Derrick Henry: 110+,yes Lamar Jackson: 40+",
        yes_subtitle: null,
        theme: "sports",
        category,
        status: "active",
        market_type: "multivariate",
        yes_bid: 0.18,
        yes_ask: 0.21,
        yes_last: 0.195,
        volume: 0,
        close_time: "2026-09-14T00:00:00Z",
        fetched_at: "2026-09-13T20:00:00.000Z",
        source: "kalshi_rfq",
      },
      {
        series_ticker: "KXNFLRSHYDS",
        market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110",
        event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
        title: "Henry 110+",
        yes_subtitle: "Derrick Henry: 110+",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.39,
        yes_ask: 0.41,
        yes_last: 0.40,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
      },
      {
        series_ticker: "KXNFLRSHYDS",
        market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40",
        event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
        title: "Jackson 40+",
        yes_subtitle: "Lamar Jackson: 40+",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.48,
        yes_ask: 0.50,
        yes_last: 0.49,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
      },
    ], Date.parse("2026-09-13T20:00:00Z"));
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.score.joint != null);
    assert.ok(Math.abs(rows[0]!.score.joint! - 0.195) < 1e-6);
    assert.ok(rows[0]!.score.flags.includes("rfq_quote"));
    assert.ok(rows[0]!.score.flags.includes("same_game"));
    assert.ok(rows[0]!.score.flags.includes("ignores_correlation"));
    assert.equal(rows[0]!.score.flags.includes("no_combo_tape"), false);
    assert.equal(rows[0]!.score.flags.includes("rfq_auction"), false);
    assert.match(rows[0]!.notes, /solicited RFQ two-way/);
    assert.ok(Math.abs(rows[0]!.score.implied_rho ?? 1) < 0.15);
  });

  it("uses the last two-sided combo candle, not latest-wins RFQ", () => {
    const category = encodeMveCategory("KXMVESPORT-NFL", [
      { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-KC", side: "yes" },
      { event_ticker: "KXNFLGAME-26SEP13BUF", market_ticker: "KXNFLGAME-26SEP13BUF-BUF", side: "yes" },
    ]);
    const combo = {
      series_ticker: "KXNFLPARLAY",
      market_ticker: "KXNFLPARLAY-26SEP13-KCBUF",
      event_ticker: "KXNFLPARLAY-26SEP13",
      title: "Chiefs win AND Bills win",
      yes_subtitle: null,
      theme: "sports",
      category,
      status: "active",
      market_type: "multivariate",
      close_time: "2026-09-14T00:00:00Z",
    };
    const rows = buildSportsRows([
      {
        ...combo,
        yes_bid: 0,
        yes_ask: 0,
        yes_last: 0,
        volume: 0,
        fetched_at: "2026-09-13T18:00:00.000Z",
      },
      {
        ...combo,
        yes_bid: 0.20,
        yes_ask: 0.24,
        yes_last: 0.22,
        volume: 40,
        fetched_at: "2026-09-12T00:00:00.000Z",
      },
      {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26SEP13KC-KC",
        event_ticker: "KXNFLGAME-26SEP13KC",
        title: "Chiefs win",
        yes_subtitle: "KC",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.70,
        yes_ask: 0.72,
        yes_last: 0.71,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
        fetched_at: "2026-09-13T18:00:00.000Z",
      },
      {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26SEP13KC-KC",
        event_ticker: "KXNFLGAME-26SEP13KC",
        title: "Chiefs win",
        yes_subtitle: "KC",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.55,
        yes_ask: 0.57,
        yes_last: 0.56,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
        fetched_at: "2026-09-12T00:00:00.000Z",
      },
      {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26SEP13BUF-BUF",
        event_ticker: "KXNFLGAME-26SEP13BUF",
        title: "Bills win",
        yes_subtitle: "BUF",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.48,
        yes_ask: 0.50,
        yes_last: 0.49,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
        fetched_at: "2026-09-12T00:00:00.000Z",
      },
    ], Date.parse("2026-09-13T12:00:00Z"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.score.joint, 0.22);
    assert.ok(Math.abs(rows[0]!.score.independence - 0.56 * 0.49) < 1e-6);
    assert.equal(rows[0]!.score.flags.includes("no_combo_tape"), false);
    assert.match(rows[0]!.notes, /last two-sided snapshot/);
  });

  it("splits crypto 15m MVEs out of the sports table", () => {
    const scored = scoreMveParlays([
      {
        series_ticker: "KXMVE",
        market_ticker: "KXMVECROSSCATEGORY-CRYPTO",
        event_ticker: null,
        title: "yes Target Price: $77,307.93,yes Target Price: $2505",
        yes_subtitle: null,
        theme: "sports",
        category: encodeMveCategory("KXMVECROSSCATEGORY-SHARD1-R", [
          { event_ticker: "KXBTC15M-26SEP131430", market_ticker: "KXBTC15M-26SEP131430-30", side: "yes" },
          { event_ticker: "KXETH15M-26SEP131430", market_ticker: "KXETH15M-26SEP131430-30", side: "yes" },
        ]),
        status: "active",
        market_type: "multivariate",
        yes_bid: 0,
        yes_ask: 0,
        yes_last: 0,
        volume: 0,
        close_time: null,
      },
      {
        series_ticker: "KXBTC",
        market_ticker: "KXBTC15M-26SEP131430-30",
        event_ticker: "KXBTC15M-26SEP131430",
        title: "BTC 15m",
        yes_subtitle: "Target Price: $77,307.93",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.60,
        yes_ask: 0.61,
        yes_last: 0.61,
        volume: 1,
        close_time: null,
      },
      {
        series_ticker: "KXETH",
        market_ticker: "KXETH15M-26SEP131430-30",
        event_ticker: "KXETH15M-26SEP131430",
        title: "ETH 15m",
        yes_subtitle: "Target Price: $2505",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.50,
        yes_ask: 0.52,
        yes_last: 0.51,
        volume: 1,
        close_time: null,
      },
    ], Date.parse("2026-09-13T12:00:00Z"));
    assert.equal(scored.sports.length, 0);
    assert.equal(scored.crypto_mves.length, 1);
    assert.equal(scored.crypto_mves[0]!.score.joint, null);
    assert.ok(scored.crypto_mves[0]!.score.flags.includes("crypto_mve"));
    assert.equal(scored.crypto_mves[0]!.score.flags.includes("independence_gap"), false);
  });

  it("splits daily crypto target-price MVEs out of the sports table", () => {
    const scored = scoreMveParlays([
      {
        series_ticker: "KXMVE",
        market_ticker: "KXMVECROSSCATEGORY-DAILYCRYPTO",
        event_ticker: null,
        title: "yes $77,300 or above,yes $100.75 or above",
        yes_subtitle: null,
        theme: "sports",
        category: encodeMveCategory("KXMVECROSSCATEGORY-SHARD1-R", [
          { event_ticker: "KXBTCD-26SEP1315", market_ticker: "KXBTCD-26SEP1315-T77299.99", side: "yes" },
          { event_ticker: "KXSOLD-26SEP1315", market_ticker: "KXSOLD-26SEP1315-T100.7499", side: "yes" },
        ]),
        status: "active",
        market_type: "multivariate",
        yes_bid: 0,
        yes_ask: 0,
        yes_last: 0,
        volume: 0,
        close_time: null,
      },
      {
        series_ticker: "KXBTCD",
        market_ticker: "KXBTCD-26SEP1315-T77299.99",
        event_ticker: "KXBTCD-26SEP1315",
        title: "BTC daily",
        yes_subtitle: "yes $77,300 or above",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.60,
        yes_ask: 0.61,
        yes_last: 0.61,
        volume: 1,
        close_time: null,
      },
      {
        series_ticker: "KXSOLD",
        market_ticker: "KXSOLD-26SEP1315-T100.7499",
        event_ticker: "KXSOLD-26SEP1315",
        title: "SOL daily",
        yes_subtitle: "yes $100.75 or above",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.50,
        yes_ask: 0.52,
        yes_last: 0.51,
        volume: 1,
        close_time: null,
      },
    ], Date.parse("2026-09-13T12:00:00Z"));
    assert.equal(scored.sports.length, 0);
    assert.equal(scored.crypto_mves.length, 1);
    assert.equal(scored.crypto_mves[0]!.tape_kind, "crypto_mve");
    assert.equal(scored.crypto_mves[0]!.score.joint, null);
  });

  it("censuses every lake combo, including RFQ rows without tradable legs", () => {
    const sportsWithLegs = encodeMveCategory("KXMVESPORT-NFL", [
      { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-KC", side: "yes" },
      { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-OVER", side: "yes" },
    ]);
    const sportsRfqOnly = encodeMveCategory("KXMVECROSSCATEGORY-SHARD1-R", [
      { event_ticker: "KXNFL1HSPREAD-26SEP13ATLPIT", market_ticker: "KXNFL1HSPREAD-26SEP13ATLPIT-PIT11", side: "no" },
      { event_ticker: "KXNFL1HTOTAL-26SEP13ATLPIT", market_ticker: "KXNFL1HTOTAL-26SEP13ATLPIT-25", side: "no" },
    ]);
    const dailyCrypto = encodeMveCategory("KXMVECROSSCATEGORY-SHARD1-R", [
      { event_ticker: "KXBTCD-26SEP1315", market_ticker: "KXBTCD-26SEP1315-T77299.99", side: "yes" },
      { event_ticker: "KXSOLD-26SEP1315", market_ticker: "KXSOLD-26SEP1315-T100.7499", side: "yes" },
    ]);
    const rfq = (ticker: string, title: string, category: string): LakeKalshiMarket => ({
      series_ticker: "KXMVE",
      market_ticker: ticker,
      event_ticker: null,
      title,
      yes_subtitle: null,
      theme: "sports",
      category,
      status: "active",
      market_type: "multivariate",
      yes_bid: 0,
      yes_ask: 0,
      yes_last: 0,
      volume: 0,
      close_time: null,
    });
    const markets: LakeKalshiMarket[] = [
      rfq("KXNFLPARLAY-SGP", "Chiefs win AND over", sportsWithLegs),
      {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26SEP13KC-KC",
        event_ticker: "KXNFLGAME-26SEP13KC",
        title: "Chiefs win",
        yes_subtitle: "KC",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.55,
        yes_ask: 0.57,
        yes_last: 0.56,
        volume: 1,
        close_time: null,
      },
      {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26SEP13KC-OVER",
        event_ticker: "KXNFLGAME-26SEP13KC",
        title: "Over 44.5",
        yes_subtitle: "Over",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.50,
        yes_ask: 0.52,
        yes_last: 0.51,
        volume: 1,
        close_time: null,
      },
      rfq("KXMVECROSSCATEGORY-RFQONLY", "1H spread AND 1H total", sportsRfqOnly),
      rfq("KXMVECROSSCATEGORY-DAILYCRYPTO", "yes $77,300 or above,yes $100.75 or above", dailyCrypto),
    ];
    const scored = scoreMveParlays(markets, Date.parse("2026-09-13T12:00:00Z"));
    assert.equal(scored.sports.length, 1);
    assert.equal(scored.crypto_mves.length, 0);
    const census = censusFromLakeMarkets(markets);
    assert.equal(census.combo_tickers, 3);
    assert.equal(census.sports_combos, 2);
    assert.equal(census.crypto_mve_combos, 1);
    assert.equal(census.mixed_combos, 0);
    assert.equal(census.same_game, 2);
    assert.equal(census.two_leg, 2);
    assert.equal(census.ever_two_sided, 0);
    assert.equal(census.tape_scored, 0);
  });
});

describe("scoreTwoLegParlay", () => {
  it("flags the Sep hike AND dissent>0 cell vs independence", () => {
    const score = scoreTwoLegParlay({
      p: 0.795,
      q: 0.69,
      joint: 0.615,
      comboSpread: 0.01,
      legSpreads: [0.01, 0.02],
    });
    assert.ok(score.gap_vs_independence != null && score.gap_vs_independence > 0.05);
    assert.ok(score.flags.includes("independence_gap"));
    assert.ok(score.implied_rho != null && score.implied_rho > 0.2);
    assert.equal(score.flags.includes("above_frechet"), false);
  });

  it("does not flag a combo sitting on the independence product", () => {
    const score = scoreTwoLegParlay({
      p: 0.4,
      q: 0.5,
      joint: 0.2,
      comboSpread: 0.02,
      legSpreads: [0.02, 0.02],
    });
    assert.equal(score.flags.includes("independence_gap"), false);
    assert.ok(Math.abs(score.gap_vs_independence ?? 1) < 1e-9);
  });

  it("homemade rows still get a copula-fair price from a return ρ", () => {
    const score = scoreTwoLegParlay({ p: 0.4, q: 0.4, rhoProxy: 0.8 });
    assert.equal(score.joint, null);
    assert.ok(score.copula_fair != null && score.copula_fair > score.independence);
  });
});

describe("returns", () => {
  it("pearson of a series with itself is 1", () => {
    const xs = logReturns([100, 101, 99, 102, 104, 103, 108, 110, 109, 111]);
    const r = pearsonCorrelation(xs, xs);
    assert.ok(r != null && Math.abs(r - 1) < 1e-9);
  });

  it("aligned overlapping OHLC produces SPY/DIA-like correlation", () => {
    const spy = [
      { date: "2026-01-01", close: 100 },
      { date: "2026-01-02", close: 101 },
      { date: "2026-01-03", close: 102 },
      { date: "2026-01-04", close: 101 },
      { date: "2026-01-05", close: 103 },
      { date: "2026-01-06", close: 104 },
      { date: "2026-01-07", close: 106 },
      { date: "2026-01-08", close: 105 },
      { date: "2026-01-09", close: 107 },
      { date: "2026-01-10", close: 108 },
    ];
    const dia = spy.map((r) => ({ date: r.date, close: r.close * 1.5 + 0.2 }));
    const corrs = buildCorrelations(
      [
        ...spy.map((r) => ({ symbol: "SPY", ...r })),
        ...dia.map((r) => ({ symbol: "DIA", ...r })),
      ],
      180,
    );
    assert.equal(corrs.length, 1);
    assert.ok(corrs[0]!.pearson > 0.99);
  });
});

function market(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    ticker: "X",
    title: "t",
    yes_sub_title: "s",
    status: "active",
    yes_bid_dollars: "0.20",
    yes_ask_dollars: "0.21",
    last_price_dollars: "0.20",
    volume_fp: "100",
    close_time: "2026-12-01T00:00:00Z",
    ...partial,
  };
}

describe("mapKalshiMarket + live filter", () => {
  it("maps dollar fields", () => {
    const q = mapKalshiMarket("KXFEDCOMBO", market({ ticker: "KXFEDCOMBO-26SEPB-25H-T0" }));
    assert.ok(q);
    assert.equal(q!.ticker, "KXFEDCOMBO-26SEPB-25H-T0");
    assert.equal(q!.yes_bid, 0.2);
    assert.equal(toQuoteView(q!).two_sided, true);
  });

  it("drops past close_time", () => {
    const q = mapKalshiMarket("KXFEDCOMBO", market({
      ticker: "KXFEDCOMBO-26JUL-25H-T0",
      close_time: "2026-07-01T00:00:00Z",
    }));
    assert.ok(q);
    assert.equal(isLiveQuote(q!, Date.parse("2026-09-13T00:00:00Z")), false);
  });
});

describe("runKalshiParlayExperiment", () => {
  const now = Date.parse("2026-09-13T12:00:00Z");

  function fixturePayload(series: string): unknown {
    if (series === "KXFEDCOMBO") {
      return {
        markets: [
          market({
            ticker: "KXFEDCOMBO-26SEPB-25H-T0",
            title: "hike AND dissents >0",
            yes_sub_title: "Rate: 25bp hike, Dissents: >0",
            yes_bid_dollars: "0.6100",
            yes_ask_dollars: "0.6200",
            last_price_dollars: "0.6200",
            close_time: "2026-09-16T17:55:00Z",
          }),
          market({
            ticker: "KXFEDCOMBO-26SEPB-25H-0",
            title: "hike AND 0 dissents",
            yes_bid_dollars: "0.2200",
            yes_ask_dollars: "0.2300",
            last_price_dollars: "0.2300",
            close_time: "2026-09-16T17:55:00Z",
          }),
          market({
            ticker: "KXFEDCOMBO-26SEPB-0-T0",
            title: "hold AND dissents >0",
            yes_bid_dollars: "0.1800",
            yes_ask_dollars: "0.1900",
            last_price_dollars: "0.1900",
            close_time: "2026-09-16T17:55:00Z",
          }),
          market({
            ticker: "KXFEDCOMBO-26SEPB-0-0",
            title: "hold AND 0 dissents",
            yes_bid_dollars: "0.0100",
            yes_ask_dollars: "0.0200",
            last_price_dollars: "0.0100",
            close_time: "2026-09-16T17:55:00Z",
          }),
        ],
      };
    }
    if (series === "KXFEDDECISION") {
      return {
        markets: [
          market({
            ticker: "KXFEDDECISION-26SEP-H25",
            yes_bid_dollars: "0.7900",
            yes_ask_dollars: "0.8000",
            last_price_dollars: "0.7900",
            close_time: "2026-09-16T17:59:00Z",
          }),
          market({
            ticker: "KXFEDDECISION-26SEP-H0",
            yes_bid_dollars: "0.2000",
            yes_ask_dollars: "0.2100",
            last_price_dollars: "0.2100",
            close_time: "2026-09-16T17:59:00Z",
          }),
        ],
      };
    }
    if (series === "KXFOMCDISSENTCOUNT") {
      return {
        markets: [
          market({
            ticker: "KXFOMCDISSENTCOUNT-26SEP-0",
            yes_bid_dollars: "0.3000",
            yes_ask_dollars: "0.3200",
            last_price_dollars: "0.3100",
            close_time: "2026-09-16T17:59:00Z",
          }),
        ],
      };
    }
    if (series === "KXBTC") {
      return {
        markets: [
          market({
            ticker: "KXBTC-26SEP1317-B77125",
            title: "BTC bucket",
            yes_sub_title: "$77,000 to 77,249.99",
            yes_bid_dollars: "0.2600",
            yes_ask_dollars: "0.2800",
            last_price_dollars: "0.2700",
            volume_fp: "4000",
            close_time: "2026-09-13T21:00:00Z",
          }),
        ],
      };
    }
    if (series === "KXETH") {
      return {
        markets: [
          market({
            ticker: "KXETH-26SEP1317-B2520",
            title: "ETH bucket",
            yes_sub_title: "$2,500 to 2,539.99",
            yes_bid_dollars: "0.2700",
            yes_ask_dollars: "0.3200",
            last_price_dollars: "0.2950",
            volume_fp: "9000",
            close_time: "2026-09-13T21:00:00Z",
          }),
        ],
      };
    }
    if (series.includes("mve_filter=only")) {
      return {
        markets: [
          market({
            ticker: "KXMVE-EMPTY",
            title: "yes Jets, yes over",
            yes_bid_dollars: "0.0000",
            yes_ask_dollars: "1.0000",
            last_price_dollars: "0.0000",
          }),
          market({
            ticker: "KXMVE-QUOTED",
            title: "quoted combo",
            yes_bid_dollars: "0.1200",
            yes_ask_dollars: "0.1800",
            last_price_dollars: "0.1500",
          }),
        ],
      };
    }
    return { markets: [] };
  }

  it("stops further Kalshi series after a 429", async () => {
    const urls: string[] = [];
    const snapshot = await runKalshiParlayExperiment({
      now: () => Date.parse("2026-09-13T12:00:00Z"),
      fetchJson: async (url: string) => {
        urls.push(url);
        throw new Error("Kalshi HTTP 429: too many requests");
      },
    });
    assert.equal(urls.filter((u) => u.includes("series_ticker=")).length, 1);
    assert.equal(urls.some((u) => u.includes("mve_filter=only")), false);
    assert.ok(snapshot.errors.some((e) => e.includes("skipped after Kalshi 429")));
  });

  it("scores listed Fed cells and homemade BTC×ETH against mocked books", async () => {
    const snapshot = await runKalshiParlayExperiment({
      now: () => now,
      fetchJson: async (url: string) => {
        const u = new URL(url);
        if (u.searchParams.get("mve_filter") === "only") return fixturePayload("mve_filter=only");
        return fixturePayload(u.searchParams.get("series_ticker") || "");
      },
      queryOhlc: async () => {
        const dates = Array.from({ length: 20 }, (_, i) => {
          const d = new Date(Date.UTC(2026, 7, 1 + i));
          return d.toISOString().slice(0, 10);
        });
        const bars = [];
        for (const [symbol, start] of [["BTC-USD", 100], ["ETH-USD", 50]] as const) {
          let px = start;
          for (const date of dates) {
            px *= 1.01;
            bars.push({ symbol, date, close: px });
          }
        }
        return bars;
      },
    });

    assert.equal(snapshot.design_id, "kalshi-parlays-v9");
    assert.equal(snapshot.sports_source, "none");
    assert.equal(snapshot.backtest.would_accept, 0);
    assert.equal(snapshot.sports.length, 0);
    assert.equal(snapshot.listed.length, 4);
    const hikeSome = snapshot.listed.find((r) => r.id.endsWith("25H-T0"));
    assert.ok(hikeSome);
    assert.ok((hikeSome!.score.gap_vs_independence ?? 0) > 0.05);
    assert.ok(hikeSome!.score.flags.includes("independence_gap"));
    assert.ok((hikeSome!.score.implied_rho ?? 0) > 0);

    const holdZero = snapshot.listed.find((r) => r.id.endsWith("-0-0"));
    assert.ok(holdZero);
    assert.ok((holdZero!.score.gap_vs_independence ?? 0) < 0);

    const dissentMarginal = snapshot.marginals.find((m) => m.name.includes("0 dissents"));
    assert.ok(dissentMarginal);
    assert.equal(dissentMarginal!.flag, true);

    assert.equal(snapshot.homemade.some((r) => r.id === "btc-eth"), true);
    const btcEth = snapshot.homemade.find((r) => r.id === "btc-eth")!;
    assert.ok(btcEth.rho_proxy != null && btcEth.rho_proxy > 0.9);
    assert.ok(btcEth.score.copula_fair != null && btcEth.score.copula_fair > btcEth.score.independence);

    assert.equal(snapshot.mve.scanned, 2);
    assert.equal(snapshot.mve.two_sided, 1);
    assert.match(snapshot.verdict.headline, /not priced as independent/i);
    assert.ok(snapshot.verdict.listed_flagged >= 1);
  });

  it("scores lake sports parlays and does not live-fetch MVE", async () => {
    const urls: string[] = [];
    const comboCategory = encodeMveCategory("KXMVESPORT-NFL", [
      { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-KC", side: "yes" },
      { event_ticker: "KXNFLGAME-26SEP13BUF", market_ticker: "KXNFLGAME-26SEP13BUF-BUF", side: "yes" },
    ]);
    const lake: LakeKalshiMarket[] = [
      {
        series_ticker: "KXNFLPARLAY",
        market_ticker: "KXNFLPARLAY-26SEP13-KCBUF",
        event_ticker: "KXNFLPARLAY-26SEP13",
        title: "Chiefs win AND Bills win",
        yes_subtitle: null,
        theme: "sports",
        category: comboCategory,
        status: "active",
        market_type: "multivariate",
        yes_bid: 0.20,
        yes_ask: 0.24,
        yes_last: 0.22,
        volume: 500,
        close_time: "2026-09-14T00:00:00Z",
      },
      {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26SEP13KC-KC",
        event_ticker: "KXNFLGAME-26SEP13KC",
        title: "Chiefs win",
        yes_subtitle: "KC",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.55,
        yes_ask: 0.57,
        yes_last: 0.56,
        volume: 9000,
        close_time: "2026-09-14T00:00:00Z",
      },
      {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26SEP13BUF-BUF",
        event_ticker: "KXNFLGAME-26SEP13BUF",
        title: "Bills win",
        yes_subtitle: "BUF",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.48,
        yes_ask: 0.50,
        yes_last: 0.49,
        volume: 8000,
        close_time: "2026-09-14T00:00:00Z",
      },
    ];
    const snapshot = await runKalshiParlayExperiment({
      now: () => now,
      fetchJson: async (url: string) => {
        urls.push(url);
        const u = new URL(url);
        return fixturePayload(u.searchParams.get("series_ticker") || "");
      },
      queryKalshiSports: async () => lake,
    });
    assert.equal(snapshot.sports_source, "lake");
    assert.equal(snapshot.sports.length, 1);
    assert.equal(snapshot.crypto_mves.length, 0);
    assert.equal(urls.some((u) => u.includes("mve_filter=only")), false);
    const row = snapshot.sports[0]!;
    assert.ok(Math.abs(row.score.independence - 0.56 * 0.49) < 1e-6);
    assert.ok(row.score.flags.includes("cross_game"));
    assert.equal(snapshot.verdict.sports_scored, 1);
    assert.equal(snapshot.mve.scanned, 1);
    assert.equal(snapshot.backtest.rfq_quotes, 0);
  });

  it("scores settled sports parlays from the last lake snapshot", () => {
    const comboCategory = encodeMveCategory("KXMVESPORT-NFL", [
      { event_ticker: "KXNFLGAME-26AUG16DAL", market_ticker: "KXNFLGAME-26AUG16DAL-DAL", side: "yes" },
      { event_ticker: "KXNFLGAME-26AUG16NYG", market_ticker: "KXNFLGAME-26AUG16NYG-NYG", side: "yes" },
    ]);
    const rows = buildSportsRows([
      {
        series_ticker: "KXNFLPARLAY",
        market_ticker: "KXNFLPARLAY-26AUG16-DALNYG",
        event_ticker: "KXNFLPARLAY-26AUG16",
        title: "Cowboys win AND Giants win",
        yes_subtitle: null,
        theme: "sports",
        category: comboCategory,
        status: "settled",
        market_type: "multivariate",
        yes_bid: 0.18,
        yes_ask: 0.22,
        yes_last: 0.20,
        volume: 120,
        close_time: "2026-08-17T00:00:00Z",
        fetched_at: "2026-08-16T00:00:00.000Z",
      },
      {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26AUG16DAL-DAL",
        event_ticker: "KXNFLGAME-26AUG16DAL",
        title: "Cowboys win",
        yes_subtitle: "DAL",
        theme: "sports",
        category: null,
        status: "settled",
        market_type: "binary",
        yes_bid: 0.62,
        yes_ask: 0.64,
        yes_last: 0.63,
        volume: 400,
        close_time: "2026-08-17T00:00:00Z",
        fetched_at: "2026-08-16T00:00:00.000Z",
      },
      {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26AUG16NYG-NYG",
        event_ticker: "KXNFLGAME-26AUG16NYG",
        title: "Giants win",
        yes_subtitle: "NYG",
        theme: "sports",
        category: null,
        status: "settled",
        market_type: "binary",
        yes_bid: 0.31,
        yes_ask: 0.33,
        yes_last: 0.32,
        volume: 300,
        close_time: "2026-08-17T00:00:00Z",
        fetched_at: "2026-08-16T00:00:00.000Z",
      },
    ], now);
    assert.equal(rows.length, 1);
    assert.ok(Math.abs(rows[0]!.score.independence - 0.63 * 0.32) < 1e-6);
    assert.match(rows[0]!.notes, /lake snapshot/i);
    assert.match(rows[0]!.notes, /2026-08-16T00:00:00.000Z/);
  });

  it("still scores lake sports after a Kalshi 429 on Fed series", async () => {
    const urls: string[] = [];
    const snapshot = await runKalshiParlayExperiment({
      now: () => now,
      fetchJson: async (url: string) => {
        urls.push(url);
        throw new Error("Kalshi HTTP 429: too many requests");
      },
      queryKalshiSports: async () => [{
        series_ticker: "KXNFLPARLAY",
        market_ticker: "KXNFLPARLAY-26SEP13-KCBUF",
        event_ticker: "KXNFLPARLAY-26SEP13",
        title: "Chiefs win AND Bills win",
        yes_subtitle: null,
        theme: "sports",
        category: encodeMveCategory("KXMVESPORT-NFL", [
          { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-KC", side: "yes" },
          { event_ticker: "KXNFLGAME-26SEP13BUF", market_ticker: "KXNFLGAME-26SEP13BUF-BUF", side: "yes" },
        ]),
        status: "active",
        market_type: "multivariate",
        yes_bid: 0.20,
        yes_ask: 0.24,
        yes_last: 0.22,
        volume: 500,
        close_time: "2026-09-14T00:00:00Z",
      }, {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26SEP13KC-KC",
        event_ticker: "KXNFLGAME-26SEP13KC",
        title: "Chiefs win",
        yes_subtitle: "KC",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.55,
        yes_ask: 0.57,
        yes_last: 0.56,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
      }, {
        series_ticker: "KXNFLGAME",
        market_ticker: "KXNFLGAME-26SEP13BUF-BUF",
        event_ticker: "KXNFLGAME-26SEP13BUF",
        title: "Bills win",
        yes_subtitle: "BUF",
        theme: "sports",
        category: null,
        status: "active",
        market_type: "binary",
        yes_bid: 0.48,
        yes_ask: 0.50,
        yes_last: 0.49,
        volume: 1,
        close_time: "2026-09-14T00:00:00Z",
      }],
    });
    assert.equal(urls.some((u) => u.includes("mve_filter=only")), false);
    assert.equal(snapshot.sports_source, "lake");
    assert.equal(snapshot.sports.length, 1);
    assert.ok(snapshot.errors.some((e) => e.includes("skipped after Kalshi 429")));
  });
});

describe("buildVerdict", () => {
  it("says so when nothing scored", () => {
    const v = buildVerdict([], [], [], {
      scanned: 10,
      two_sided: 0,
      empty_book: 10,
      sample_titles: [],
    }, []);
    assert.match(v.headline, /Could not score/);
  });

  it("says same-game parlays have correlated legs that independence would miss", () => {
    const v = buildVerdict([], [], [], {
      scanned: 275,
      two_sided: 0,
      empty_book: 275,
      sample_titles: [],
      combo_tickers: 275,
      ever_two_sided: 0,
      sports_combos: 77,
      crypto_mve_combos: 198,
      mixed_combos: 0,
      same_game: 18,
      cross_game: 26,
      two_leg: 23,
      tape_scored: 0,
      tape_flagged: 0,
      corr_room_max: 0.229,
      corr_room_mean: 0.20,
      survives_spread_fees: 0,
    }, [], [{
      id: "rfq",
      kind: "sports_mve",
      meeting: "KXMVECROSSCATEGORY-SHARD1-R",
      label: "same-game RFQ",
      combo: null,
      legs: [],
      score: {
        p: 0.5,
        q: 0.5,
        joint: null,
        independence: 0.25,
        frechet_low: 0,
        frechet_high: 0.5,
        corr_room: 0.25,
        gap_vs_independence: null,
        phi: null,
        implied_rho: null,
        copula_fair: null,
        gap_vs_copula: null,
        flags: ["same_game", "no_combo_tape"],
      },
      rho_proxy: null,
      rho_proxy_source: null,
      notes: "",
    }]);
    assert.match(v.headline, /correlated legs/i);
    assert.match(v.headline, /23¢/);
    assert.match(v.bullets.join(" "), /same-game/);
    assert.equal(v.sports_flagged, 0);
  });

  it("quotes implied ρ from two-sided combo books, not 0/1 Fréchet corners", () => {
    const liquid = {
      id: "liquid",
      kind: "listed_combo" as const,
      meeting: "26SEP",
      label: "hike AND dissent",
      combo: {
        ticker: "liquid",
        title: "liquid",
        subtitle: null,
        yes_bid: 0.61,
        yes_ask: 0.62,
        yes_last: 0.615,
        mid: 0.615,
        spread: 0.01,
        volume: 1,
        close_time: null,
        two_sided: true,
      },
      legs: [],
      score: {
        p: 0.795,
        q: 0.685,
        joint: 0.615,
        independence: 0.544575,
        frechet_low: 0.48,
        frechet_high: 0.685,
        corr_room: 0.140425,
        gap_vs_independence: 0.070425,
        phi: 0.38,
        implied_rho: 0.60,
        copula_fair: null,
        gap_vs_copula: null,
        flags: ["independence_gap"],
      },
      rho_proxy: null,
      rho_proxy_source: null,
      notes: "",
    };
    const illiquid = {
      ...liquid,
      id: "illiquid",
      label: "cut AND dissent",
      combo: { ...liquid.combo, ticker: "illiquid", two_sided: false, yes_bid: 0, yes_ask: 0.01, mid: 0.005 },
      score: {
        ...liquid.score,
        p: 0.005,
        q: 0.685,
        joint: 0.005,
        independence: 0.003425,
        gap_vs_independence: 0.001575,
        implied_rho: 0.90,
        flags: [],
      },
    };
    const v = buildVerdict([liquid, illiquid], [], [], {
      scanned: 0,
      two_sided: 0,
      empty_book: 0,
      sample_titles: [],
    }, []);
    assert.equal(v.max_abs_implied_rho, 0.6);
    assert.match(v.bullets.join(" "), /two-sided listed cell is 0\.60/);
  });

  it("still reports lake return correlation when homemade rows are missing", () => {
    const v = buildVerdict([], [], [], {
      scanned: 0,
      two_sided: 0,
      empty_book: 0,
      sample_titles: [],
    }, [{
      symbol_a: "SPY",
      symbol_b: "DIA",
      n: 120,
      pearson: 0.84,
      lookback_days: 180,
    }]);
    assert.match(v.bullets.join(" "), /SPY×DIA 0\.84/);
  });
});

describe("kalshiParlayCacheTtlMs", () => {
  it("pins a 429/empty miss for 90s and a scored snapshot for 10 minutes", () => {
    assert.equal(kalshiParlayCacheTtlMs({ listed: [], errors: ["KXFEDCOMBO: Kalshi HTTP 429"] }), 90_000);
    assert.equal(kalshiParlayCacheTtlMs({ listed: [{ id: "x" }], errors: [] }), 10 * 60 * 1000);
    assert.equal(kalshiParlayCacheTtlMs({ listed: [], errors: [] }), 10 * 60 * 1000);
  });
});

describe("parlay strategy backtest", () => {
  function lakeRow(partial: Partial<LakeKalshiMarket> & Pick<LakeKalshiMarket, "market_ticker">): LakeKalshiMarket {
    return {
      series_ticker: "KXMVE",
      event_ticker: null,
      title: partial.market_ticker,
      yes_subtitle: null,
      theme: "sports",
      category: null,
      status: "active",
      market_type: "binary",
      yes_bid: 0.4,
      yes_ask: 0.42,
      yes_last: 0.41,
      volume: 10,
      close_time: null,
      fetched_at: "2026-09-14T23:00:00.000Z",
      source: "kalshi",
      ...partial,
    };
  }

  it("buys YES at the ask on a same-game RFQ near independence and grades settlement", () => {
    const category = encodeMveCategory("KXMVESPORT-MLB", [
      { event_ticker: "KXMLBGAME-26SEP14ATLHOU", market_ticker: "KXMLBHITS-HARRIS-3", side: "yes" },
      { event_ticker: "KXMLBGAME-26SEP14ATLHOU", market_ticker: "KXMLBHITS-BREGMAN-3", side: "yes" },
    ]);
    const result = backtestParlayStrategy([
      lakeRow({
        market_ticker: "KXMVE-HARRIS-BREGMAN",
        title: "Harris 3+ AND Bregman 3+",
        category,
        market_type: "multivariate",
        yes_bid: 0.18,
        yes_ask: 0.20,
        yes_last: 0.19,
        source: "kalshi_rfq",
        fetched_at: "2026-09-14T23:10:00.000Z",
      }),
      lakeRow({
        market_ticker: "KXMVE-HARRIS-BREGMAN",
        title: "Harris 3+ AND Bregman 3+",
        category,
        status: "settled",
        yes_bid: 1,
        yes_ask: 1,
        yes_last: 1,
        source: "kalshi_settlement",
        fetched_at: "2026-09-15T04:00:00.000Z",
        close_time: "2026-09-15T04:00:00.000Z",
      }),
      lakeRow({
        market_ticker: "KXMLBHITS-HARRIS-3",
        event_ticker: "KXMLBGAME-26SEP14ATLHOU",
        yes_bid: 0.39,
        yes_ask: 0.41,
        yes_last: 0.40,
      }),
      lakeRow({
        market_ticker: "KXMLBHITS-BREGMAN-3",
        event_ticker: "KXMLBGAME-26SEP14ATLHOU",
        yes_bid: 0.48,
        yes_ask: 0.50,
        yes_last: 0.49,
      }),
    ]);
    assert.equal(result.would_accept, 1);
    assert.equal(result.strategy.settled, 1);
    assert.equal(result.strategy.yes_wins, 1);
    assert.ok(result.strategy.yes_pnl > 7);
    assert.ok(result.strategy.no_pnl < -8);
    assert.equal(result.fills[0]?.settlement, 1);
  });

  it("skips mixed-side RFQs and still reports the control tape", () => {
    const category = encodeMveCategory("KXMVESPORT-MLB", [
      { event_ticker: "KXMLBGAME-26SEP14ATLHOU", market_ticker: "KXMLBHITS-HARRIS-3", side: "yes" },
      { event_ticker: "KXMLBGAME-26SEP14ATLHOU", market_ticker: "KXMLBHITS-BREGMAN-3", side: "no" },
    ]);
    const result = backtestParlayStrategy([
      lakeRow({
        market_ticker: "KXMVE-MIXED",
        title: "mixed",
        category,
        market_type: "multivariate",
        yes_bid: 0.18,
        yes_ask: 0.20,
        source: "kalshi_rfq",
      }),
      lakeRow({
        market_ticker: "KXMLBHITS-HARRIS-3",
        event_ticker: "KXMLBGAME-26SEP14ATLHOU",
        yes_bid: 0.39,
        yes_ask: 0.41,
        yes_last: 0.40,
      }),
      lakeRow({
        market_ticker: "KXMLBHITS-BREGMAN-3",
        event_ticker: "KXMLBGAME-26SEP14ATLHOU",
        yes_bid: 0.48,
        yes_ask: 0.50,
        yes_last: 0.49,
      }),
    ]);
    assert.equal(result.would_accept, 0);
    assert.equal(result.same_game, 1);
    assert.equal(result.fills.length, 0);
  });

  it("grades last-night BUY NO fills against settlement and a YES counterfactual", () => {
    const result = backtestParlayStrategy([
      lakeRow({
        market_ticker: "KXMVECROSSCATEGORY-SHARD1-S20269E72B42AB9D-AB9C373A907",
        title: "Harris 3+ AND Bregman 3+",
        yes_subtitle: "buy_no",
        yes_bid: 0.25,
        yes_ask: 0.25,
        no_bid: 0.75,
        volume: 10,
        liquidity: 0.1313,
        source: "kalshi_parlay_fill",
        fetched_at: "2026-09-15T00:52:39.777723Z",
      }),
      lakeRow({
        market_ticker: "KXMVECROSSCATEGORY-SHARD1-S20269E72B42AB9D-AB9C373A907",
        title: "Harris 3+ AND Bregman 3+",
        status: "settled",
        yes_bid: 0,
        yes_ask: 0,
        yes_last: 0,
        source: "kalshi_settlement",
        fetched_at: "2026-09-15T04:13:18.619804Z",
      }),
    ]);
    assert.equal(result.live.n, 1);
    assert.equal(result.live.settled, 1);
    assert.equal(result.live.wins, 1);
    assert.ok(Math.abs(result.live.actual_pnl - 2.3687) < 1e-3);
    assert.ok(result.live.yes_counterfactual_pnl < -2.5);
    assert.equal(result.live.fills[0]?.fill_side, "no");
  });
});

describe("clampProb", () => {
  it("stays off 0/1", () => {
    assert.ok(clampProb(0) > 0);
    assert.ok(clampProb(1) < 1);
  });
});
