import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  diversifyResearchKalshiMarkets,
  isLiveKalshiMarket,
  kalshiRelatedSymbolKeys,
  kalshiSeriesUrl,
  kalshiYesProb,
  mapKalshiMarketBrief,
  rankResearchKalshiMarkets,
  selectResearchKalshiMarkets,
  summarizeKalshiForResearch,
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

  it("diversifies so one series cannot fill the whole rail", () => {
    const items = selectResearchKalshiMarkets(
      [
        {
          series_ticker: "KXFACEBOOKAPP",
          market_ticker: "APP-1",
          title: "Downloads > 100",
          theme: "company_event",
          status: "open",
          volume_24h: 900,
          close_time: "2027-01-01T00:00:00Z",
          related_symbol: "META",
        },
        {
          series_ticker: "KXFACEBOOKAPP",
          market_ticker: "APP-2",
          title: "Downloads > 99",
          theme: "company_event",
          status: "open",
          volume_24h: 800,
          close_time: "2027-01-01T00:00:00Z",
          related_symbol: "META",
        },
        {
          series_ticker: "KXFACEBOOKAPP",
          market_ticker: "APP-3",
          title: "Downloads > 98",
          theme: "company_event",
          status: "open",
          volume_24h: 700,
          close_time: "2027-01-01T00:00:00Z",
          related_symbol: "META",
        },
        {
          series_ticker: "KXMETAANTITRUST",
          market_ticker: "ANTI-1",
          title: "FTC antitrust revived?",
          theme: "company_event",
          status: "open",
          volume_24h: 50,
          close_time: "2027-01-01T00:00:00Z",
          related_symbol: "META",
        },
        {
          series_ticker: "KXMETAKIDSCASE",
          market_ticker: "KIDS-1",
          title: "Kids case damages?",
          theme: "company_event",
          status: "open",
          volume_24h: 40,
          close_time: "2027-01-01T00:00:00Z",
          related_symbol: "META",
        },
      ],
      4,
    );
    assert.equal(items.length, 4);
    const series = items.map((i) => i.series_ticker);
    assert.ok(series.includes("KXMETAANTITRUST"));
    assert.ok(series.includes("KXMETAKIDSCASE"));
    assert.equal(series.filter((s) => s === "KXFACEBOOKAPP").length, 2);
  });

  it("does not overflow a series when other series can still fill the rail", () => {
    const items = diversifyResearchKalshiMarkets(
      [
        brief({ market_ticker: "APP-1", series_ticker: "KXFACEBOOKAPP", volume_24h: 900 }),
        brief({ market_ticker: "APP-2", series_ticker: "KXFACEBOOKAPP", volume_24h: 800 }),
        brief({ market_ticker: "APP-3", series_ticker: "KXFACEBOOKAPP", volume_24h: 700 }),
        brief({ market_ticker: "ANTI-1", series_ticker: "KXMETAANTITRUST", volume_24h: 50 }),
        brief({ market_ticker: "KIDS-1", series_ticker: "KXMETAKIDSCASE", volume_24h: 40 }),
      ],
      5,
      2,
    );
    assert.equal(items.length, 4);
    assert.equal(items.filter((i) => i.series_ticker === "KXFACEBOOKAPP").length, 2);
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

describe("kalshiRelatedSymbolKeys", () => {
  it("expands Alphabet dual-class tickers", () => {
    assert.deepEqual(kalshiRelatedSymbolKeys("GOOG"), ["GOOG", "GOOGL"]);
    assert.deepEqual(kalshiRelatedSymbolKeys("googl"), ["GOOG", "GOOGL"]);
    assert.deepEqual(kalshiRelatedSymbolKeys("META"), ["META"]);
  });
});

describe("summarizeKalshiForResearch", () => {
  it("formats YES odds for fundamental context", () => {
    const text = summarizeKalshiForResearch([
      brief({
        market_ticker: "KXMETAANTITRUST-26DEC31",
        series_ticker: "KXMETAANTITRUST",
        title: "FTC antitrust case against Meta revived on appeal?",
        theme: "company_event",
        yes_last: 0.27,
      }),
    ]);
    assert.ok(text);
    assert.match(text!, /27% YES/);
    assert.match(text!, /FTC antitrust/);
    assert.match(text!, /company_event/);
  });

  it("returns null when empty", () => {
    assert.equal(summarizeKalshiForResearch([]), null);
  });
});
