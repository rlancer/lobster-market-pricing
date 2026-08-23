import { describe, expect, it } from "vitest";
import {
  collectFramedPoints,
  parseCompanyFacts,
  periodTypeFromFp,
} from "./company-facts.js";

describe("periodTypeFromFp", () => {
  it("maps SEC fp values", () => {
    expect(periodTypeFromFp("FY")).toBe("FY");
    expect(periodTypeFromFp("Q2")).toBe("Q2");
  });

  it("infers from frame when fp missing", () => {
    expect(periodTypeFromFp(null, "CY2026Q2")).toBe("Q2");
    expect(periodTypeFromFp(null, "CY2025")).toBe("FY");
  });
});

describe("collectFramedPoints", () => {
  it("keeps framed duration points for P&L metrics and skips unframed YTD", () => {
    const tag = {
      units: {
        USD: [
          { end: "2026-06-27", val: 10_523_000_000, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-07-31", frame: null },
          { end: "2026-06-27", val: 3_401_000_000, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-07-31", frame: "CY2026Q2" },
        ],
      },
    };
    const points = collectFramedPoints(tag, "share_based_compensation");
    expect(points).toHaveLength(1);
    expect(points[0].val).toBe(3_401_000_000);
    expect(points[0].frame).toBe("CY2026Q2");
  });

  it("prefers instant frames for balance-sheet metrics", () => {
    const tag = {
      units: {
        USD: [
          { end: "2026-06-27", val: 71_340_000_000, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-07-31", frame: "CY2026Q2I" },
          { end: "2026-06-27", val: 999, fy: 2026, fp: "Q3", form: "10-Q", filed: "2026-07-31", frame: "CY2026Q2" },
        ],
      },
    };
    const points = collectFramedPoints(tag, "long_term_debt");
    expect(points).toHaveLength(1);
    expect(points[0].val).toBe(71_340_000_000);
  });
});

describe("parseCompanyFacts", () => {
  it("builds period rows with SBC and debt from us-gaap tags", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            units: {
              USD: [
                {
                  end: "2026-06-27",
                  val: 109_417_000_000,
                  fy: 2026,
                  fp: "Q3",
                  form: "10-Q",
                  filed: "2026-07-31",
                  frame: "CY2026Q2",
                },
              ],
            },
          },
          NetIncomeLoss: {
            units: {
              USD: [
                {
                  end: "2026-06-27",
                  val: 29_789_000_000,
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
                  val: 3_401_000_000,
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
                  val: 71_340_000_000,
                  fy: 2026,
                  fp: "Q3",
                  form: "10-Q",
                  filed: "2026-07-31",
                  frame: "CY2026Q2I",
                },
              ],
            },
          },
          CashAndCashEquivalentsAtCarryingValue: {
            units: {
              USD: [
                {
                  end: "2026-06-27",
                  val: 39_544_000_000,
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
    };
    const rows = parseCompanyFacts(payload, "AAPL", "0000320193", "run-1", "2026-08-23T00:00:00.000Z");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const q = rows.find((r) => r.period_end === "2026-06-27" && r.period_type === "Q3");
    expect(q).toBeTruthy();
    expect(q!.revenue).toBe(109_417_000_000);
    expect(q!.net_income).toBe(29_789_000_000);
    expect(q!.share_based_compensation).toBe(3_401_000_000);
    expect(q!.long_term_debt).toBe(71_340_000_000);
    expect(q!.cash).toBe(39_544_000_000);
    expect(q!.source).toBe("edgar");
  });
});
