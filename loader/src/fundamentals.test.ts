import { describe, expect, it } from "vitest";
import { parseFundamentalsQuoteSummary, yahooSymbol } from "./fundamentals.js";
import { securityIdForTicker } from "./symbology.js";

const AAPL_PAYLOAD = {
  quoteSummary: {
    result: [
      {
        summaryDetail: {
          marketCap: { raw: 3_500_000_000_000 },
          trailingPE: { raw: 32.1 },
          forwardPE: { raw: 28.4 },
        },
        defaultKeyStatistics: {
          enterpriseValue: { raw: 3_600_000_000_000 },
          pegRatio: { raw: 2.1 },
          priceToBook: { raw: 45.5 },
          trailingPE: { raw: 31.9 },
        },
        financialData: {
          totalDebt: { raw: 100_000_000_000 },
          debtToEquity: { raw: 150.2 },
          profitMargins: { raw: 0.25 },
          revenueGrowth: { raw: 0.08 },
        },
      },
    ],
  },
};

describe("yahooSymbol", () => {
  it("maps class shares to Yahoo dash form", () => {
    expect(yahooSymbol("BRK.B")).toBe("BRK-B");
    expect(yahooSymbol("aapl")).toBe("AAPL");
  });
});

describe("parseFundamentalsQuoteSummary", () => {
  it("maps quoteSummary modules onto a fundamentals row", () => {
    const row = parseFundamentalsQuoteSummary(
      AAPL_PAYLOAD,
      "AAPL",
      "2026-08-16T12:00:00.000Z",
    );
    expect(row.ticker).toBe("AAPL");
    expect(row.security_id).toBe(securityIdForTicker("AAPL"));
    expect(row.market_cap).toBe(3_500_000_000_000);
    expect(row.enterprise_value).toBe(3_600_000_000_000);
    expect(row.trailing_pe).toBeCloseTo(32.1);
    expect(row.forward_pe).toBeCloseTo(28.4);
    expect(row.peg_ratio).toBeCloseTo(2.1);
    expect(row.price_to_book).toBeCloseTo(45.5);
    expect(row.total_debt).toBe(100_000_000_000);
    expect(row.debt_to_equity).toBeCloseTo(150.2);
    expect(row.profit_margins).toBeCloseTo(0.25);
    expect(row.revenue_growth).toBeCloseTo(0.08);
    expect(row.source).toBe("yahoo");
    expect(row.fetched_at).toBe("2026-08-16T12:00:00.000Z");
  });

  it("falls back to stats trailingPE when summaryDetail omits it", () => {
    const row = parseFundamentalsQuoteSummary(
      {
        quoteSummary: {
          result: [{
            summaryDetail: { marketCap: { raw: 1 } },
            defaultKeyStatistics: { trailingPE: { raw: 18.5 } },
            financialData: {},
          }],
        },
      },
      "MSFT",
      "2026-08-16T00:00:00.000Z",
    );
    expect(row.trailing_pe).toBeCloseTo(18.5);
  });

  it("throws on an empty quoteSummary result", () => {
    expect(() => parseFundamentalsQuoteSummary(
      { quoteSummary: { result: null, error: { description: "Invalid Crumb" } } },
      "AAPL",
      "2026-08-16T00:00:00.000Z",
    )).toThrow(/Invalid Crumb/);
  });
});
