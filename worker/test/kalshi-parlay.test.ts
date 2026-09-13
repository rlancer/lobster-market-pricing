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
  scoreTwoLegParlay,
} from "../src/kalshi-parlay";
import {
  buildCorrelations,
  buildVerdict,
  isLiveQuote,
  mapKalshiMarket,
  runKalshiParlayExperiment,
  toQuoteView,
} from "../src/kalshi-parlay-experiment";

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

    assert.equal(snapshot.design_id, "kalshi-parlays-v1");
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

describe("clampProb", () => {
  it("stays off 0/1", () => {
    assert.ok(clampProb(0) > 0);
    assert.ok(clampProb(1) < 1);
  });
});
