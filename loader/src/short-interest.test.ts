import { describe, expect, it, vi } from "vitest";
import {
  buildFinraSymbolMaps,
  finraSymbol,
  normalizeShortInterestRecords,
  parseFinraShortInterestPage,
  parseFinraShortInterestRow,
  publishShortInterestDate,
  shortInterestSettlementCandidates,
} from "./short-interest.js";

const FINRA_AAPL = {
  stockSplitFlag: null,
  previousShortPositionQuantity: 146547784,
  averageDailyVolumeQuantity: 58400983,
  issueName: "Apple Inc. Common Stock",
  currentShortPositionQuantity: 141606163,
  changePreviousNumber: -4941621,
  accountingYearMonthNumber: 20260731,
  settlementDate: "2026-07-31",
  marketClassCode: "NNM",
  symbolCode: "AAPL",
  daysToCoverQuantity: 2.42,
  issuerServicesGroupExchangeCode: "R",
  revisionFlag: null,
  changePercent: -3.37,
};

const FINRA_BRKB = {
  ...FINRA_AAPL,
  symbolCode: "BRKB",
  issueName: "Berkshire Hathaway Inc. Class B",
  currentShortPositionQuantity: 11111111,
  previousShortPositionQuantity: 10000000,
  changePreviousNumber: 1111111,
  changePercent: 11.11,
  daysToCoverQuantity: 1.5,
  marketClassCode: "NYSE",
};

const FINRA_ZZZZ = {
  ...FINRA_AAPL,
  symbolCode: "ZZZZ",
  issueName: "Not In Universe",
};

describe("finraSymbol", () => {
  it("strips share-class dots and slashes", () => {
    expect(finraSymbol("BRK.B")).toBe("BRKB");
    expect(finraSymbol("BF.B")).toBe("BFB");
    expect(finraSymbol("brk/b")).toBe("BRKB");
    expect(finraSymbol("AAPL")).toBe("AAPL");
  });
});

describe("shortInterestSettlementCandidates", () => {
  it("emits mid-month and month-end walk-backs, newest first, deduped", () => {
    const now = Date.UTC(2026, 7, 20); // 2026-08-20
    const dates = shortInterestSettlementCandidates(now, 2, 1);
    expect(dates[0]).toBe("2026-08-15");
    expect(dates).toContain("2026-08-14");
    expect(dates).toContain("2026-08-31");
    expect(dates).toContain("2026-08-30");
    expect(dates).toContain("2026-07-15");
    expect(dates).toContain("2026-07-31");
    expect(new Set(dates).size).toBe(dates.length);
  });
});

describe("parseFinraShortInterestRow / page", () => {
  it("maps FINRA codes back to lake symbols and drops out-of-universe rows", () => {
    const { finraToLake } = buildFinraSymbolMaps(["AAPL", "BRK.B", "MSFT"]);
    const aapl = parseFinraShortInterestRow(FINRA_AAPL, finraToLake)!;
    expect(aapl).toMatchObject({
      symbol: "AAPL",
      settlement_date: "2026-07-31",
      short_interest: 141606163,
      prev_short_interest: 146547784,
      short_interest_change: -4941621,
      short_interest_change_pct: -3.37,
      avg_daily_volume: 58400983,
      days_to_cover: 2.42,
      market_class: "NNM",
      issue_name: "Apple Inc. Common Stock",
    });

    const brk = parseFinraShortInterestRow(FINRA_BRKB, finraToLake)!;
    expect(brk.symbol).toBe("BRK.B");

    expect(parseFinraShortInterestRow(FINRA_ZZZZ, finraToLake)).toBeNull();

    const page = parseFinraShortInterestPage(
      [FINRA_AAPL, FINRA_BRKB, FINRA_ZZZZ, FINRA_AAPL],
      finraToLake,
    );
    expect(page.map((r) => r.symbol).sort()).toEqual(["AAPL", "BRK.B"]);
  });

  it("skips malformed payloads", () => {
    const { finraToLake } = buildFinraSymbolMaps(["AAPL"]);
    expect(parseFinraShortInterestPage(null, finraToLake)).toEqual([]);
    expect(parseFinraShortInterestPage({ rows: [] }, finraToLake)).toEqual([]);
    expect(
      parseFinraShortInterestRow(
        { ...FINRA_AAPL, currentShortPositionQuantity: null },
        finraToLake,
      ),
    ).toBeNull();
  });
});

describe("normalizeShortInterestRecords", () => {
  it("emits field-ordered records with source metadata", () => {
    const { finraToLake } = buildFinraSymbolMaps(["AAPL"]);
    const row = parseFinraShortInterestRow(FINRA_AAPL, finraToLake)!;
    const [rec] = normalizeShortInterestRecords([row], "finra", "run-1", "2026-08-20T00:00:00.000Z");
    expect(rec.source).toBe("finra");
    expect(rec.run_id).toBe("run-1");
    expect(rec.fetched_at).toBe("2026-08-20T00:00:00.000Z");
    expect(rec.symbol).toBe("AAPL");
    expect(rec.short_interest).toBe(141606163);
  });
});

describe("publishShortInterestDate", () => {
  it("requires PIPELINE_SHORT_INTEREST_URL", async () => {
    await expect(
      publishShortInterestDate("2026-07-31", {}, new Set(["AAPL"])),
    ).rejects.toThrow(/PIPELINE_SHORT_INTEREST_URL/);
  });

  it("skips publish when FINRA returns 204 (unpublished settlement date)", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    try {
      const result = await publishShortInterestDate(
        "2026-08-15",
        {
          PIPELINE_SHORT_INTEREST_URL: "https://pipeline.test/si",
          HTTP_RETRIES: 0,
          runId: () => "run-skip",
          now: () => Date.UTC(2026, 7, 20),
        },
        new Set(["AAPL"]),
      );
      expect(result).toMatchObject({
        settlement_date: "2026-08-15",
        row_count: 0,
        published: false,
        run_id: "run-skip",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pages FINRA, filters to keep set, and POSTs once to the pipeline", async () => {
    const posts: Array<{ body: unknown; key: string | null }> = [];
    let finraCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("finra.org")) {
        finraCalls += 1;
        const req = JSON.parse(String(init?.body)) as { offset: number; limit: number };
        if (req.offset === 0) {
          // First page: universe hit + noise; second page empty → stop.
          return new Response(JSON.stringify([FINRA_AAPL, FINRA_ZZZZ, FINRA_BRKB]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      posts.push({
        body: JSON.parse(String(init?.body)),
        key: new Headers(init?.headers).get("idempotency-key"),
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const result = await publishShortInterestDate(
        "2026-07-31",
        {
          PIPELINE_SHORT_INTEREST_URL: "https://pipeline.test/si",
          PIPELINE_AUTH_TOKEN: "tok",
          HTTP_RETRIES: 0,
          SHORT_INTEREST_PAGE_SIZE: 5000,
          runId: () => "run-pub",
          now: () => Date.UTC(2026, 7, 20),
        },
        new Set(["AAPL", "BRK.B"]),
      );
      expect(result.published).toBe(true);
      expect(result.row_count).toBe(2);
      // One page (< page size) — no follow-up offset request.
      expect(finraCalls).toBe(1);
      expect(posts).toHaveLength(1);
      expect(posts[0].key).toBe("short_interest:run-pub:2026-07-31");
      const rows = posts[0].body as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.symbol).sort()).toEqual(["AAPL", "BRK.B"]);
      expect(rows.every((r) => r.source === "finra" && r.run_id === "run-pub")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
