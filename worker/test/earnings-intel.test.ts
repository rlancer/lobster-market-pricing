import { describe, expect, it } from "vitest";
import {
  buildEarningsQuality,
  synthesizeEarningsSummary,
  type CompanyFactBrief,
  type EarningsResultBrief,
} from "../src/earnings-intel";

const baseFact = (over: Partial<CompanyFactBrief> = {}): CompanyFactBrief => ({
  period_end: "2026-06-27",
  period_type: "Q3",
  fiscal_year: 2026,
  form: "10-Q",
  filed_at: "2026-07-31",
  revenue: 100e9,
  net_income: 10e9,
  operating_cash_flow: 12e9,
  diluted_eps: 2,
  share_based_compensation: 2e9,
  long_term_debt: 50e9,
  long_term_debt_current: 5e9,
  cash: 20e9,
  operating_lease_liability: 10e9,
  finance_lease_liability: 1e9,
  interest_expense: 0.5e9,
  ...over,
});

describe("buildEarningsQuality", () => {
  it("flags material SBC and computes adjusted NI / net debt", () => {
    const q = buildEarningsQuality([baseFact()]);
    expect(q.period_end).toBe("2026-06-27");
    expect(q.sbc_pct_of_net_income).toBeCloseTo(0.2);
    expect(q.sbc_adjusted_net_income).toBe(12e9);
    expect(q.net_debt).toBe(35e9);
    expect(q.flags.some((f) => f.id === "sbc_material")).toBe(true);
    expect(q.flags.some((f) => f.id === "lease_debt")).toBe(true);
  });

  it("alerts when SBC exceeds net income", () => {
    const q = buildEarningsQuality([
      baseFact({ net_income: 1e9, share_based_compensation: 2e9 }),
    ]);
    expect(q.flags.some((f) => f.id === "sbc_exceeds_ni")).toBe(true);
  });
});

describe("synthesizeEarningsSummary", () => {
  it("mentions beat/miss and quality flags", () => {
    const results: EarningsResultBrief[] = [
      {
        quarter_end: "2025-09-30",
        period_label: "-1q",
        eps_actual: 1.85,
        eps_estimate: 1.77,
        eps_difference: 0.08,
        surprise_pct: 0.045,
        currency: "USD",
      },
    ];
    const quality = buildEarningsQuality([baseFact()]);
    const text = synthesizeEarningsSummary("AAPL", results, [baseFact()], [], quality);
    expect(text).toMatch(/AAPL printed EPS 1\.85/);
    expect(text).toMatch(/Stock-based compensation|SBC/i);
  });
});
