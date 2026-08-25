import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isLiveKalshiMarket,
  kalshiSeriesUrl,
  kalshiYesProb,
  mapKalshiMarketBrief,
  parseKalshiParam,
  rankResearchKalshiMarkets,
  selectResearchKalshiMarkets,
  type KalshiMarketBrief,
} from "../src/research-kalshi";

function brief(partial: Partial<KalshiMarketBrief> & Pick<KalshiMarketBrief, "market_ticker">): KalshiMarketBrief {
  return {
    series_ticker: "KXFED",
    event_ticker: null,
    title: "Fed funds",
    yes_subtitle: null,
    theme: "rates",
    status: "open",
    yes_bid: 0.4,
    yes_ask: 0.42,
    yes_last: 0.41,
    volume: 100,
    volume_24h: 50,
    open_interest: 10,
    close_time: "2027-04-27T00:00:00Z",
    related_symbol: "TLT",
    url: "https://kalshi.com/markets/kxfed",
    ...partial,
  };
}

describe("kalshiSeriesUrl", () => {
  it("builds a series page URL for allowlisted tickers", () => {
    assert.equal(kalshiSeriesUrl("KXFED"), "https://kalshi.com/markets/kxfed");
    assert.equal(kalshiSeriesUrl("kxbtc"), "https://kalshi.com/markets/kxbtc");
  });

  it("rejects junk", () => {
    assert.equal(kalshiSeriesUrl(""), null);
    assert.equal(kalshiSeriesUrl("../evil"), null);
    assert.equal(kalshiSeriesUrl("KX FED"), null);
  });
});

describe("parseKalshiParam", () => {
  it("accepts market and series tickers", () => {
    assert.equal(parseKalshiParam("kxfed-27apr-t4.25"), "KXFED-27APR-T4.25");
    assert.equal(parseKalshiParam("KXFED"), "KXFED");
  });

  it("rejects junk", () => {
    assert.equal(parseKalshiParam(""), null);
    assert.equal(parseKalshiParam("a"), null);
    assert.equal(parseKalshiParam("../x"), null);
  });
});

describe("mapKalshiMarketBrief", () => {
  it("normalizes lake rows", () => {
    const mapped = mapKalshiMarketBrief({
      series_ticker: "kxinx",
      market_ticker: "kxinx-26dec-t6000",
      event_ticker: "kxinx-26dec",
      title: "S&P 500",
      yes_subtitle: "6000 or above",
      theme: "equity_index",
      status: "open",
      yes_bid: 0.18,
      yes_ask: 0.2,
      yes_last: 0.19,
      volume: 1000,
      volume_24h: 200,
      open_interest: 50,
      close_time: "2026-12-31T21:00:00Z",
      related_symbol: "spy",
    });
    assert.ok(mapped);
    assert.equal(mapped!.series_ticker, "KXINX");
    assert.equal(mapped!.market_ticker, "KXINX-26DEC-T6000");
    assert.equal(mapped!.related_symbol, "SPY");
    assert.equal(mapped!.url, "https://kalshi.com/markets/kxinx");
  });

  it("drops rows without tickers", () => {
    assert.equal(mapKalshiMarketBrief({ title: "x" }), null);
  });
});

describe("rank + select", () => {
  it("prefers higher 24h volume then sooner close", () => {
    const ranked = rankResearchKalshiMarkets([
      brief({ market_ticker: "A", volume_24h: 10, close_time: "2027-01-01T00:00:00Z" }),
      brief({ market_ticker: "B", volume_24h: 50, close_time: "2027-06-01T00:00:00Z" }),
      brief({ market_ticker: "C", volume_24h: 50, close_time: "2027-02-01T00:00:00Z" }),
    ]);
    assert.deepEqual(ranked.map((r) => r.market_ticker), ["C", "B", "A"]);
  });

  it("filters settled / past-close markets and caps", () => {
    const now = Date.parse("2026-08-23T12:00:00Z");
    const items = selectResearchKalshiMarkets(
      [
        {
          series_ticker: "KXFED",
          market_ticker: "LIVE",
          title: "Live",
          theme: "rates",
          status: "open",
          yes_last: 0.5,
          volume_24h: 100,
          close_time: "2027-01-01T00:00:00Z",
          related_symbol: "TLT",
        },
        {
          series_ticker: "KXFED",
          market_ticker: "DEAD",
          title: "Dead",
          theme: "rates",
          status: "settled",
          yes_last: 0.9,
          volume_24h: 999,
          close_time: "2027-01-01T00:00:00Z",
          related_symbol: "TLT",
        },
        {
          series_ticker: "KXFED",
          market_ticker: "PAST",
          title: "Past",
          theme: "rates",
          status: "open",
          yes_last: 0.1,
          volume_24h: 80,
          close_time: "2026-01-01T00:00:00Z",
          related_symbol: "TLT",
        },
      ],
      5,
      now,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]!.market_ticker, "LIVE");
  });
});

describe("kalshiYesProb + isLive", () => {
  it("prefers last then mid", () => {
    assert.equal(kalshiYesProb(brief({ yes_last: 0.41 })), 0.41);
    assert.equal(
      kalshiYesProb(brief({ yes_last: null, yes_bid: 0.4, yes_ask: 0.5 })),
      0.45,
    );
  });

  it("treats closed status as not live", () => {
    assert.equal(isLiveKalshiMarket(brief({ status: "closed" })), false);
    assert.equal(isLiveKalshiMarket(brief({ status: "open" })), true);
  });
});
