import { describe, expect, it } from "vitest";
import {
  fillToMarketRow,
  isParlayComboTicker,
  parseKalshiPortfolioFill,
  parseKalshiPortfolioSettlement,
  settlementYesFromFill,
  KALSHI_PARLAY_FILL_SOURCE,
  PARLAY_FILL_NO,
} from "./kalshi-parlay-fills.js";
import { marketRowsFromParlayFills } from "./kalshi-parlay-tape.js";
import { KALSHI_SETTLEMENT_SOURCE } from "./kalshi-settlement.js";

const FILL_RAW = {
  action: "buy",
  count_fp: "10.00",
  created_time: "2026-09-15T00:52:39.777723Z",
  fee_cost: "0.131300",
  is_taker: true,
  market_ticker: "KXMVECROSSCATEGORY-SHARD1-S20269E72B42AB9D-AB9C373A907",
  no_price_dollars: "0.7500",
  side: "no",
  ticker: "KXMVECROSSCATEGORY-SHARD1-S20269E72B42AB9D-AB9C373A907",
  yes_price_dollars: "0.2500",
};

describe("kalshi parlay fill tape", () => {
  it("keeps KXMVE combo tickers and drops singles", () => {
    expect(isParlayComboTicker(FILL_RAW.ticker)).toBe(true);
    expect(isParlayComboTicker("KXNFLGAME-26SEP13DALNYG-DAL")).toBe(false);
  });

  it("parses a BUY NO 10-contract RFQ fill", () => {
    const fill = parseKalshiPortfolioFill(FILL_RAW);
    expect(fill).toMatchObject({
      side: "no",
      contracts: 10,
      yes_price: 0.25,
      no_price: 0.75,
      fee: 0.1313,
    });
  });

  it("infers YES=0 when BUY NO collected revenue and YES=1 when it did not", () => {
    const fill = parseKalshiPortfolioFill(FILL_RAW)!;
    expect(settlementYesFromFill(fill, 1000)).toBe(0);
    expect(settlementYesFromFill(fill, 0)).toBe(1);
    expect(settlementYesFromFill({ side: "yes" }, 1000)).toBe(1);
    expect(settlementYesFromFill({ side: "yes" }, 0)).toBe(0);
  });

  it("maps fill + settlement onto lake rows without mixing 0/1 into the fill quote", () => {
    const fill = parseKalshiPortfolioFill(FILL_RAW)!;
    const settled = parseKalshiPortfolioSettlement({
      ticker: FILL_RAW.ticker,
      revenue: 1000,
      settled_time: "2026-09-15T04:13:18.619804Z",
    });
    const raw = {
      ticker: FILL_RAW.ticker,
      title: "Harris 3+ AND Bregman 3+",
      status: "settled",
      market_type: "multivariate",
      mve_collection_ticker: "KXMVESPORT-MLB",
      mve_selected_legs: [
        { event_ticker: "KXMLBGAME-26SEP14ATLHOU", market_ticker: "KXMLBHITS-HARRIS-3", side: "yes" },
        { event_ticker: "KXMLBGAME-26SEP14ATLHOU", market_ticker: "KXMLBHITS-BREGMAN-3", side: "yes" },
      ],
    };
    const rows = marketRowsFromParlayFills([fill], settled ? [settled] : [], new Map([[FILL_RAW.ticker, raw]]));
    const fillRow = rows.find((row) => row.source === KALSHI_PARLAY_FILL_SOURCE);
    const settleRow = rows.find((row) => row.source === KALSHI_SETTLEMENT_SOURCE);
    expect(fillRow?.yes_subtitle).toBe(PARLAY_FILL_NO);
    expect(fillRow?.yes_bid).toBe(0.25);
    expect(fillRow?.no_bid).toBe(0.75);
    expect(fillRow?.volume).toBe(10);
    expect(fillRow?.liquidity).toBe(0.1313);
    expect(fillRow?.category).toContain("KXMLBHITS-HARRIS-3");
    expect(settleRow?.yes_last).toBe(0);
    expect(settleRow?.source).toBe(KALSHI_SETTLEMENT_SOURCE);
    const orphan = fillToMarketRow(fill);
    expect(orphan.source).toBe(KALSHI_PARLAY_FILL_SOURCE);
    expect(orphan.series_ticker).toBe("KXMVECROSSCATEGORY");
  });
});
