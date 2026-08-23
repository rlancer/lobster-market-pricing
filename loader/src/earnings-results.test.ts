import { describe, expect, it } from "vitest";
import {
  parseEarningsHistory,
  quarterEndFromYahoo,
} from "./earnings-results.js";

describe("quarterEndFromYahoo", () => {
  it("prefers fmt YYYY-MM-DD", () => {
    expect(quarterEndFromYahoo({ raw: 1759190400, fmt: "2025-09-30" })).toBe("2025-09-30");
  });

  it("falls back to epoch seconds", () => {
    expect(quarterEndFromYahoo({ raw: 1759190400 })).toBe("2025-09-30");
  });
});

describe("parseEarningsHistory", () => {
  it("maps earningsHistory rows", () => {
    const payload = {
      quoteSummary: {
        result: [
          {
            earningsHistory: {
              history: [
                {
                  epsActual: { raw: 1.85 },
                  epsEstimate: { raw: 1.77 },
                  epsDifference: { raw: 0.08 },
                  surprisePercent: { raw: 0.0452 },
                  quarter: { raw: 1759190400, fmt: "2025-09-30" },
                  currency: "USD",
                  period: "-4q",
                },
                {
                  epsActual: { raw: 2.46 },
                  epsEstimate: { raw: 2.36 },
                  epsDifference: { raw: 0.1 },
                  surprisePercent: { raw: 0.042 },
                  quarter: { raw: 1743465600, fmt: "2025-06-30" },
                  currency: "USD",
                  period: "-3q",
                },
              ],
            },
          },
        ],
      },
    };
    const rows = parseEarningsHistory(payload, "AAPL", "run-1", "2026-08-23T00:00:00.000Z");
    expect(rows).toHaveLength(2);
    expect(rows[0].symbol).toBe("AAPL");
    expect(rows[0].quarter_end).toBe("2025-09-30");
    expect(rows[0].eps_actual).toBe(1.85);
    expect(rows[0].surprise_pct).toBeCloseTo(0.0452);
    expect(rows[0].period_label).toBe("-4q");
    expect(rows[0].source).toBe("yahoo");
    expect(rows[1].quarter_end).toBe("2025-06-30");
  });

  it("throws on yahoo error payload", () => {
    expect(() =>
      parseEarningsHistory(
        { quoteSummary: { result: null, error: { description: "Not found" } } },
        "ZZZ",
        "r",
        "t",
      ),
    ).toThrow(/Not found/);
  });
});
