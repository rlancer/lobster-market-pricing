import { describe, expect, it } from "vitest";
import {
  accessionFolder,
  edgarDocumentUrl,
  filingKindForForm,
  padCik,
  parseCompanyTickers,
  parseSubmissionsFilings,
} from "./sec.js";
import { securityIdForTicker } from "./symbology.js";

describe("sec.ts unit surface", () => {
  it("exports stable URL + form helpers used by the job", () => {
    expect(padCik(884394)).toBe("0000884394");
    expect(accessionFolder("0001193125-24-000111")).toBe("000119312524000111");
    expect(filingKindForForm("497K", true)).toBe("prospectus");
    expect(edgarDocumentUrl("884394", "0001193125-24-000111", null)).toMatch(
      /\/Archives\/edgar\/data\/884394\/000119312524000111\/$/,
    );
    const map = parseCompanyTickers({
      "0": { cik_str: "884394", ticker: "spy", title: "SPDR" },
    });
    expect(map.get("SPY")).toBe("0000884394");
    const rows = parseSubmissionsFilings(
      {
        cik: "884394",
        filings: {
          recent: {
            accessionNumber: ["acc-1"],
            filingDate: ["2024-01-01"],
            reportDate: [""],
            form: ["N-1A"],
            primaryDocument: ["n1a.htm"],
            primaryDocDescription: ["N-1A"],
          },
        },
      },
      "SPY",
      { isEtf: true, runId: "r", fetchedAt: "t" },
    );
    expect(rows[0].security_id).toBe(securityIdForTicker("SPY"));
    expect(rows[0].kind).toBe("prospectus");
  });
});
