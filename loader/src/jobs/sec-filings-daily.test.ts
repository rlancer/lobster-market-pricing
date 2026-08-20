import { describe, expect, it, vi } from "vitest";
import {
  accessionFolder,
  edgarDocumentUrl,
  filingKindForForm,
  padCik,
  parseCompanyTickers,
  parseSubmissionsFilings,
  publishSecFilings,
  type SecEnv,
} from "../sec.js";
import { securityIdForTicker } from "../symbology.js";
import {
  isEtfTicker,
  secFilingsBundledUniverse,
  secFilingsDailyJob,
} from "./sec-filings-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const PIPELINE_SEC_FILINGS_URL = "https://pipeline.test/sec-filings";

describe("sec helpers", () => {
  it("pads CIKs and builds EDGAR document URLs", () => {
    expect(padCik("320193")).toBe("0000320193");
    expect(padCik(320193)).toBe("0000320193");
    expect(accessionFolder("0000320193-24-000123")).toBe("000032019324000123");
    expect(
      edgarDocumentUrl("0000320193", "0000320193-24-000123", "aapl-20240928.htm"),
    ).toBe(
      "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
    );
  });

  it("classifies equity vs prospectus form types", () => {
    expect(filingKindForForm("10-K", false)).toBe("filing");
    expect(filingKindForForm("485BPOS", true)).toBe("prospectus");
    expect(filingKindForForm("485BPOS", false)).toBeNull();
    expect(filingKindForForm("10-Q", true)).toBe("filing");
    expect(filingKindForForm("13F-HR", false)).toBeNull();
  });

  it("parses company_tickers.json into a ticker→CIK map", () => {
    const map = parseCompanyTickers({
      "0": { cik_str: "320193", ticker: "AAPL", title: "Apple Inc." },
      "1": { cik_str: "884394", ticker: "SPY", title: "SPDR S&P 500 ETF TRUST" },
    });
    expect(map.get("AAPL")).toBe("0000320193");
    expect(map.get("SPY")).toBe("0000884394");
  });

  it("parses submissions.recent into filing rows with kind + edgar_url", () => {
    const rows = parseSubmissionsFilings(
      {
        cik: "320193",
        filings: {
          recent: {
            accessionNumber: ["0000320193-24-000123", "0000320193-24-000050", "0000320193-24-000001"],
            filingDate: ["2024-11-01", "2024-08-01", "2024-05-01"],
            reportDate: ["2024-09-28", "2024-06-29", "2024-03-30"],
            form: ["10-K", "10-Q", "4"],
            primaryDocument: ["aapl-10k.htm", "aapl-10q.htm", "form4.xml"],
            primaryDocDescription: ["10-K", "10-Q", "Form 4"],
          },
        },
      },
      "AAPL",
      { isEtf: false, runId: "run-1", fetchedAt: "2026-08-20T00:00:00.000Z" },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].form_type).toBe("10-K");
    expect(rows[0].kind).toBe("filing");
    expect(rows[0].security_id).toBe(securityIdForTicker("AAPL"));
    expect(rows[0].edgar_url).toContain("aapl-10k.htm");
    expect(rows[1].form_type).toBe("10-Q");
  });

  it("keeps prospectus forms for ETFs", () => {
    const rows = parseSubmissionsFilings(
      {
        cik: "884394",
        filings: {
          recent: {
            accessionNumber: ["0001193125-24-000111"],
            filingDate: ["2024-01-15"],
            reportDate: ["2024-01-15"],
            form: ["485BPOS"],
            primaryDocument: ["d485bpos.htm"],
            primaryDocDescription: ["485BPOS"],
          },
        },
      },
      "SPY",
      { isEtf: true, runId: "run-2", fetchedAt: "2026-08-20T00:00:00.000Z" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("prospectus");
    expect(rows[0].form_type).toBe("485BPOS");
  });
});

describe("secFilingsBundledUniverse / isEtfTicker", () => {
  it("includes equities and curated ETFs", () => {
    const symbols = secFilingsBundledUniverse();
    expect(symbols).toContain("AAPL");
    expect(symbols).toContain("SPY");
    expect(symbols).toContain("IBIT");
    expect(isEtfTicker("SPY")).toBe(true);
    expect(isEtfTicker("AAPL")).toBe(false);
  });
});

describe("sec-filings-daily job adapter", () => {
  it("dry-runs with no pipeline URL", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = secFilingsDailyJob({} as SchedulerEnv);
      expect(job.id).toBe("sec-filings-daily");
      expect(job.marketGated).toBe(false);
      const result = await job.run(["AAPL", "SPY"], {} as SchedulerEnv);
      expect(result.runId).toBeNull();
      expect(result.failures).toEqual([]);
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes filtered filings for symbols with a CIK", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("company_tickers")) {
        return new Response(
          JSON.stringify({
            "0": { cik_str: "320193", ticker: "AAPL", title: "Apple" },
          }),
          { status: 200 },
        );
      }
      if (url.includes("submissions/CIK")) {
        return new Response(
          JSON.stringify({
            cik: "320193",
            filings: {
              recent: {
                accessionNumber: ["0000320193-24-000123"],
                filingDate: ["2024-11-01"],
                reportDate: ["2024-09-28"],
                form: ["10-K"],
                primaryDocument: ["aapl-10k.htm"],
                primaryDocDescription: ["Annual report"],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url === PIPELINE_SEC_FILINGS_URL) {
        posts.push({ url, body: JSON.parse(String(init?.body || "[]")) });
        return new Response("{}", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const job = secFilingsDailyJob({
        SEC_FILINGS_CONCURRENCY: 1,
        PIPELINE_SEC_FILINGS_URL,
        PIPELINE_AUTH_TOKEN: "token",
        runId: () => "run-fixed",
      } as SchedulerEnv);
      const result = await job.run(["AAPL"], {
        PIPELINE_SEC_FILINGS_URL,
        PIPELINE_AUTH_TOKEN: "token",
        runId: () => "run-fixed",
      } as SchedulerEnv);
      expect(result.runId).toBe("run-fixed");
      expect(result.failures).toEqual([]);
      expect(posts).toHaveLength(1);
      const rows = posts[0].body as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].ticker).toBe("AAPL");
      expect(rows[0].form_type).toBe("10-K");
      expect(rows[0].kind).toBe("filing");
      expect(rows[0].source).toBe("edgar");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("publishSecFilings", () => {
  it("skips tickers with no CIK without throwing", async () => {
    const env: SecEnv = {
      PIPELINE_SEC_FILINGS_URL,
      runId: () => "r1",
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    };
    const result = await publishSecFilings("NOTICKER", env, {
      isEtf: false,
      cikMap: new Map(),
    });
    expect(result.published).toBe(false);
    expect(result.row_count).toBe(0);
    expect(result.cik).toBeNull();
  });
});
