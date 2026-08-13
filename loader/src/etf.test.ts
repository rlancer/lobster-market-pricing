import { describe, expect, it } from "vitest";
import { parseQuoteSummary } from "./etf.js";

const SPY_PAYLOAD = {
  quoteSummary: {
    result: [
      {
        fundProfile: {
          family: "State Street Investment Management",
          categoryName: "Large Blend",
          legalType: "Exchange Traded Fund",
          feesExpensesInvestment: {
            annualReportExpenseRatio: { raw: 0.000945, fmt: "0.09%" },
            netExpRatio: { raw: 0.000945, fmt: "0.09%" },
            totalNetAssets: { raw: 496384.34 },
          },
        },
        defaultKeyStatistics: {
          totalAssets: { raw: 795306885120 },
          fundInceptionDate: { raw: 727660800, fmt: "1993-01-22" },
        },
        summaryDetail: {
          yield: { raw: 0.0101, fmt: "1.01%" },
        },
        topHoldings: {
          holdings: [
            { symbol: "NVDA", holdingName: "NVIDIA Corp", holdingPercent: { raw: 0.0754943 } },
            { symbol: "AAPL", holdingName: "Apple Inc", holdingPercent: { raw: 0.065 } },
          ],
        },
      },
    ],
  },
};

describe("parseQuoteSummary", () => {
  it("maps fundProfile + topHoldings onto profile/holdings records", () => {
    const { profile, holdings } = parseQuoteSummary(
      SPY_PAYLOAD,
      "SPY",
      { name: "SPDR S&P 500 ETF Trust", asset_class: "Broad Market" },
      "run-1",
      "2026-08-13T02:00:00.000Z",
    );
    expect(profile.ticker).toBe("SPY");
    expect(profile.name).toBe("SPDR S&P 500 ETF Trust");
    expect(profile.family).toBe("State Street Investment Management");
    expect(profile.category).toBe("Large Blend");
    expect(profile.asset_class).toBe("Broad Market");
    expect(profile.expense_ratio).toBeCloseTo(0.000945);
    expect(profile.net_assets).toBe(795306885120);
    expect(profile.trailing_yield).toBeCloseTo(0.0101);
    expect(profile.inception_date).toBe("1993-01-22");
    expect(profile.source).toBe("yahoo");
    expect(profile.run_id).toBe("run-1");
    expect(holdings).toHaveLength(2);
    expect(holdings[0]).toMatchObject({
      ticker: "SPY", rank: 1, holding_symbol: "NVDA", holding_name: "NVIDIA Corp",
    });
    expect(holdings[0].weight).toBeCloseTo(0.0754943);
    expect(holdings[1].holding_symbol).toBe("AAPL");
    expect(holdings[1].rank).toBe(2);
  });

  it("throws on an empty quoteSummary result", () => {
    expect(() => parseQuoteSummary(
      { quoteSummary: { result: null, error: { description: "Invalid Crumb" } } },
      "SPY",
      {},
      "r",
      "2026-08-13T00:00:00.000Z",
    )).toThrow(/Invalid Crumb/);
  });
});
