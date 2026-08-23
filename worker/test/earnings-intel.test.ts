import { describe, expect, it } from "vitest";
import {
  buildEarningsQuality,
  htmlToPlainText,
  pickEarningsReportFiling,
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

describe("pickEarningsReportFiling", () => {
  it("prefers 8-K descriptions that look like earnings releases", () => {
    const pick = pickEarningsReportFiling([
      {
        form_type: "10-Q",
        description: "Quarterly report",
        edgar_url: "https://sec.gov/10q",
        filed_at: "2026-07-01",
      },
      {
        form_type: "8-K",
        description: "Other events",
        edgar_url: "https://sec.gov/other",
        filed_at: "2026-07-20",
      },
      {
        form_type: "8-K",
        description: "Results of Operations and Financial Condition",
        edgar_url: "https://sec.gov/earnings",
        filed_at: "2026-07-31",
      },
    ]);
    expect(pick?.edgar_url).toBe("https://sec.gov/earnings");
  });
});

describe("htmlToPlainText", () => {
  it("strips tags and scripts", () => {
    const text = htmlToPlainText(
      "<html><script>evil()</script><body><p>Revenue&nbsp;<b>grew</b></p></body></html>",
    );
    expect(text).toBe("Revenue grew");
    expect(text).not.toMatch(/script|evil/i);
  });
});
