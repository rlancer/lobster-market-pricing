import { describe, expect, it, vi } from "vitest";
import {
  accumulateRegShoFacilityRow,
  buildRegShoSymbolMaps,
  finalizeRegShoAccum,
  normalizeRegShoRecords,
  publishRegShoDate,
  regShoSipSymbol,
  regShoTradeDateCandidates,
  shortRatio,
} from "./reg-sho.js";

const FACILITY_AAPL_NQ = {
  reportingFacilityCode: "NQTRF",
  totalParQuantity: 1000,
  shortParQuantity: 400,
  marketCode: "Q",
  tradeReportDate: "2026-08-18",
  securitiesInformationProcessorSymbolIdentifier: "AAPL",
  shortExemptParQuantity: 10,
};

const FACILITY_AAPL_NY = {
  ...FACILITY_AAPL_NQ,
  reportingFacilityCode: "NYTRF",
  marketCode: "N",
  totalParQuantity: 500,
  shortParQuantity: 100,
  shortExemptParQuantity: 0,
};

const FACILITY_BRK = {
  ...FACILITY_AAPL_NQ,
  securitiesInformationProcessorSymbolIdentifier: "BRK/B",
  totalParQuantity: 200,
  shortParQuantity: 50,
  shortExemptParQuantity: 0,
};

const FACILITY_ZZZZ = {
  ...FACILITY_AAPL_NQ,
  securitiesInformationProcessorSymbolIdentifier: "ZZZZ",
};

describe("regShoSipSymbol", () => {
  it("maps share-class dots to SIP slashes", () => {
    expect(regShoSipSymbol("BRK.B")).toBe("BRK/B");
    expect(regShoSipSymbol("BF.B")).toBe("BF/B");
    expect(regShoSipSymbol("AAPL")).toBe("AAPL");
  });
});

describe("regShoTradeDateCandidates", () => {
  it("lists today back through lookback-1, newest first", () => {
    const now = Date.UTC(2026, 7, 20);
    expect(regShoTradeDateCandidates(now, 3)).toEqual([
      "2026-08-20",
      "2026-08-19",
      "2026-08-18",
    ]);
  });
});

describe("shortRatio / facility rollup", () => {
  it("computes ratio and rolls facilities into one lake row", () => {
    expect(shortRatio(500, 1500)).toBeCloseTo(1 / 3);
    expect(shortRatio(0, 0)).toBeNull();

    const { sipToLake } = buildRegShoSymbolMaps(["AAPL", "BRK.B"]);
    const acc = new Map();
    for (const raw of [FACILITY_AAPL_NQ, FACILITY_AAPL_NY, FACILITY_BRK, FACILITY_ZZZZ]) {
      accumulateRegShoFacilityRow(raw, sipToLake, acc);
    }
    const rows = finalizeRegShoAccum(acc).sort((a, b) => a.symbol.localeCompare(b.symbol));
    expect(rows).toHaveLength(2);

    const aapl = rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl).toMatchObject({
      trade_date: "2026-08-18",
      short_volume: 500,
      short_exempt_volume: 10,
      total_volume: 1500,
      facility_count: 2,
    });
    expect(aapl.short_ratio).toBeCloseTo(500 / 1500);

    const brk = rows.find((r) => r.symbol === "BRK.B")!;
    expect(brk.short_volume).toBe(50);
    expect(brk.facility_count).toBe(1);
  });
});

describe("normalizeRegShoRecords", () => {
  it("emits field-ordered records with source metadata", () => {
    const [rec] = normalizeRegShoRecords(
      [{
        symbol: "AAPL",
        trade_date: "2026-08-18",
        short_volume: 500,
        short_exempt_volume: 10,
        total_volume: 1500,
        short_ratio: 500 / 1500,
        facility_count: 2,
      }],
      "finra",
      "run-1",
      "2026-08-20T00:00:00.000Z",
    );
    expect(rec).toMatchObject({
      symbol: "AAPL",
      source: "finra",
      run_id: "run-1",
      fetched_at: "2026-08-20T00:00:00.000Z",
      short_volume: 500,
    });
  });
});

describe("publishRegShoDate", () => {
  it("requires PIPELINE_REG_SHO_URL", async () => {
    await expect(
      publishRegShoDate("2026-08-18", {}, new Set(["AAPL"])),
    ).rejects.toThrow(/PIPELINE_REG_SHO_URL/);
  });

  it("skips publish when FINRA returns 204 (weekend / holiday)", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    try {
      const result = await publishRegShoDate(
        "2026-08-16",
        {
          PIPELINE_REG_SHO_URL: "https://pipeline.test/regsho",
          HTTP_RETRIES: 0,
          runId: () => "run-skip",
          now: () => Date.UTC(2026, 7, 20),
        },
        new Set(["AAPL"]),
      );
      expect(result).toMatchObject({
        trade_date: "2026-08-16",
        row_count: 0,
        published: false,
        run_id: "run-skip",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("pages FINRA, aggregates facilities, filters universe, POSTs once", async () => {
    const posts: Array<{ body: unknown; key: string | null }> = [];
    let finraCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("finra.org")) {
        finraCalls += 1;
        const req = JSON.parse(String(init?.body)) as { offset: number };
        if (req.offset === 0) {
          return new Response(
            JSON.stringify([FACILITY_AAPL_NQ, FACILITY_AAPL_NY, FACILITY_BRK, FACILITY_ZZZZ]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      posts.push({
        body: JSON.parse(String(init?.body)),
        key: new Headers(init?.headers).get("idempotency-key"),
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const result = await publishRegShoDate(
        "2026-08-18",
        {
          PIPELINE_REG_SHO_URL: "https://pipeline.test/regsho",
          PIPELINE_AUTH_TOKEN: "tok",
          HTTP_RETRIES: 0,
          REG_SHO_PAGE_SIZE: 5000,
          runId: () => "run-pub",
          now: () => Date.UTC(2026, 7, 20),
        },
        new Set(["AAPL", "BRK.B"]),
      );
      expect(result.published).toBe(true);
      expect(result.row_count).toBe(2);
      expect(finraCalls).toBe(1);
      expect(posts).toHaveLength(1);
      expect(posts[0].key).toBe("reg_sho:run-pub:2026-08-18");
      const rows = posts[0].body as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.symbol).sort()).toEqual(["AAPL", "BRK.B"]);
      const aapl = rows.find((r) => r.symbol === "AAPL")!;
      expect(aapl.short_volume).toBe(500);
      expect(aapl.total_volume).toBe(1500);
      expect(aapl.facility_count).toBe(2);
      expect(rows.every((r) => r.source === "finra" && r.run_id === "run-pub")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
