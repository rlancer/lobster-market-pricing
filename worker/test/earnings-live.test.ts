import { describe, expect, it } from "vitest";
import { parseLiveCompanyFacts, parseLiveEarningsHistory } from "../src/earnings-live";

describe("parseLiveEarningsHistory", () => {
  it("maps Yahoo earningsHistory rows", () => {
    const rows = parseLiveEarningsHistory({
      quoteSummary: {
        result: [
          {
            earningsHistory: {
              history: [
                {
                  epsActual: { raw: 1.85 },
                  epsEstimate: { raw: 1.77 },
                  epsDifference: { raw: 0.08 },
                  surprisePercent: { raw: 0.045 },
                  quarter: { fmt: "2025-09-30" },
                  currency: "USD",
                  period: "-1q",
                },
              ],
            },
          },
        ],
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].eps_actual).toBe(1.85);
    expect(rows[0].quarter_end).toBe("2025-09-30");
  });
});

describe("parseLiveCompanyFacts", () => {
  it("builds SBC + debt periods from us-gaap tags", () => {
    const rows = parseLiveCompanyFacts({
      facts: {
        "us-gaap": {
          NetIncomeLoss: {
            units: {
              USD: [
                {
                  end: "2026-06-27",
                  val: 29e9,
                  fy: 2026,
                  fp: "Q3",
                  form: "10-Q",
                  filed: "2026-07-31",
                  frame: "CY2026Q2",
                },
              ],
            },
          },
          AllocatedShareBasedCompensationExpense: {
            units: {
              USD: [
                {
                  end: "2026-06-27",
                  val: 3.4e9,
                  fy: 2026,
                  fp: "Q3",
                  form: "10-Q",
                  filed: "2026-07-31",
                  frame: "CY2026Q2",
                },
              ],
            },
          },
          LongTermDebtNoncurrent: {
            units: {
              USD: [
                {
                  end: "2026-06-27",
                  val: 71e9,
                  fy: 2026,
                  fp: "Q3",
                  form: "10-Q",
                  filed: "2026-07-31",
                  frame: "CY2026Q2I",
                },
              ],
            },
          },
        },
      },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const q = rows.find((r) => r.period_end === "2026-06-27");
    expect(q?.net_income).toBe(29e9);
    expect(q?.share_based_compensation).toBe(3.4e9);
    expect(q?.long_term_debt).toBe(71e9);
  });
});
