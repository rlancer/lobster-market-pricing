import { describe, expect, it, vi } from "vitest";
import {
  earningsDateForOffset,
  fetchEarningsDate,
  normalizeEarningsRecords,
  parseCount,
  parseNasdaqEarnings,
  parseUsdAmount,
  publishEarningsDate,
} from "./earnings.js";

// Fixture: rows captured verbatim from the live Nasdaq calendar endpoint
// (2026-08-10, https://api.nasdaq.com/api/calendar/earnings?date=2026-08-10),
// trimmed to a representative mix: after-hours, pre-market, not-supplied,
// negative parenthesized EPS, empty forecast, "N/A" estimate count.
const NASDAQ_PAYLOAD = {
  data: {
    asOf: "Mon, Aug 10, 2026",
    rows: [
      {
        lastYearRptDt: "8/04/2025", lastYearEPS: "$3.05", time: "time-after-hours",
        symbol: "SPG", name: "Simon Property Group, Inc.",
        marketCap: "$71,937,231,179", fiscalQuarterEnding: "Jun/2026",
        epsForecast: "$3.18", noOfEsts: "7",
      },
      {
        lastYearRptDt: "8/07/2025", lastYearEPS: "($0.13)", time: "time-after-hours",
        symbol: "RKLB", name: "Rocket Lab Corporation",
        marketCap: "$43,802,901,833", fiscalQuarterEnding: "Jun/2026",
        epsForecast: "($0.07)", noOfEsts: "1",
      },
      {
        lastYearRptDt: "8/11/2025", lastYearEPS: "$0.47", time: "time-pre-market",
        symbol: "B", name: "Barrick Mining Corporation",
        marketCap: "$69,456,575,188", fiscalQuarterEnding: "Jun/2026",
        epsForecast: "$0.81", noOfEsts: "6",
      },
      {
        lastYearRptDt: "8/11/2025", lastYearEPS: "$0.10", time: "time-not-supplied",
        symbol: "SBS", name: "Companhia de saneamento Basico Do Estado De Sao Paulo - Sabesp",
        marketCap: "$18,926,747,714", fiscalQuarterEnding: "Jun/2026",
        epsForecast: "", noOfEsts: "N/A",
      },
    ],
  },
};

describe("parseUsdAmount", () => {
  it("parses Nasdaq money strings, including parenthesized negatives", () => {
    expect(parseUsdAmount("$3.18")).toBe(3.18);
    expect(parseUsdAmount("($0.07)")).toBe(-0.07);
    expect(parseUsdAmount("$0.47")).toBe(0.47);
  });

  it("returns null for empty / non-numeric values", () => {
    expect(parseUsdAmount("")).toBeNull();
    expect(parseUsdAmount(null)).toBeNull();
    expect(parseUsdAmount("N/A")).toBeNull();
  });
});

describe("parseCount", () => {
  it("parses integer counts and rejects N/A", () => {
    expect(parseCount("7")).toBe(7);
    expect(parseCount("N/A")).toBeNull();
    expect(parseCount("")).toBeNull();
  });
});

describe("parseNasdaqEarnings", () => {
  it("normalizes rows, stripping time- prefixes and mapping not-supplied to null", () => {
    const rows = parseNasdaqEarnings(NASDAQ_PAYLOAD, "2026-08-10");
    expect(rows).toHaveLength(4);

    const spg = rows.find((r) => r.symbol === "SPG")!;
    expect(spg).toMatchObject({
      symbol: "SPG",
      earnings_date: "2026-08-10",
      time: "after-hours",
      name: "Simon Property Group, Inc.",
      fiscal_q: "Jun/2026",
      eps_forecast: 3.18,
      est_count: 7,
      last_year_eps: 3.05,
    });

    const rklb = rows.find((r) => r.symbol === "RKLB")!;
    expect(rklb.eps_forecast).toBe(-0.07);
    expect(rklb.last_year_eps).toBe(-0.13);

    const b = rows.find((r) => r.symbol === "B")!;
    expect(b.time).toBe("pre-market");

    const sbs = rows.find((r) => r.symbol === "SBS")!;
    expect(sbs.time).toBeNull();
    expect(sbs.eps_forecast).toBeNull();
    expect(sbs.est_count).toBeNull();
  });

  it("skips malformed / duplicate rows and non-object payloads", () => {
    const dup = parseNasdaqEarnings(
      { data: { rows: [NASDAQ_PAYLOAD.data.rows[0], NASDAQ_PAYLOAD.data.rows[0], { symbol: "" }] } },
      "2026-08-10",
    );
    expect(dup).toHaveLength(1);
    expect(parseNasdaqEarnings({ nope: true }, "2026-08-10")).toEqual([]);
    expect(parseNasdaqEarnings(null, "2026-08-10")).toEqual([]);
  });
});

describe("normalizeEarningsRecords", () => {
  it("emits records in EARNINGS_FIELDS order with run metadata", () => {
    const rows = parseNasdaqEarnings(NASDAQ_PAYLOAD, "2026-08-10");
    const records = normalizeEarningsRecords(rows, "nasdaq", "run-1", "2026-08-10T12:00:00Z");
    expect(records).toHaveLength(4);
    expect(Object.keys(records[0])).toEqual([
      "symbol", "earnings_date", "time", "name", "fiscal_q",
      "eps_forecast", "est_count", "last_year_eps", "source", "run_id", "fetched_at",
    ]);
    expect(records[0]).toMatchObject({
      symbol: "SPG", earnings_date: "2026-08-10", source: "nasdaq",
      run_id: "run-1", fetched_at: "2026-08-10T12:00:00Z",
    });
  });
});

describe("earningsDateForOffset", () => {
  it("formats UTC YYYY-MM-DD with correct offsets", () => {
    const now = Date.UTC(2026, 7, 8); // 2026-08-08
    expect(earningsDateForOffset(now, 0)).toBe("2026-08-08");
    expect(earningsDateForOffset(now, 1)).toBe("2026-08-09");
    expect(earningsDateForOffset(now, 13)).toBe("2026-08-21");
  });
});

describe("fetchEarningsDate", () => {
  it("GETs the template URL with a browser-ish UA and parses JSON", async () => {
    let called: RequestInfo | URL | null = null;
    let ua = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      called = input;
      ua = String((init?.headers as Record<string, string> | undefined)?.["user-agent"] ?? "");
      return new Response(JSON.stringify(NASDAQ_PAYLOAD), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const payload = await fetchEarningsDate("2026-08-10", { HTTP_RETRIES: 0 });
      expect(String(called)).toContain("date=2026-08-10");
      expect(ua).toContain("Mozilla");
      expect(parseNasdaqEarnings(payload, "2026-08-10")).toHaveLength(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries up to HTTP_RETRIES then throws (all statuses, like fetchOhlc)", async () => {
    for (const status of [503, 404]) {
      const calls: number[] = [];
      vi.stubGlobal("fetch", async () => {
        calls.push(1);
        return new Response("boom", { status });
      });
      try {
        await expect(fetchEarningsDate("2026-08-10", { HTTP_RETRIES: 2, RETRY_BACKOFF_SECONDS: 0 }))
          .rejects.toThrow(/after 3 attempts/);
        expect(calls.length).toBe(3);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
});

describe("publishEarningsDate", () => {
  it("requires PIPELINE_EARNINGS_URL", async () => {
    await expect(publishEarningsDate("2026-08-10")).rejects.toThrow(/PIPELINE_EARNINGS_URL/);
  });

  it("fetches, filters to keepSymbols, and posts normalized records", async () => {
    const posts: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("nasdaq.com")) {
        return new Response(JSON.stringify(NASDAQ_PAYLOAD), { status: 200 });
      }
      posts.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const keep = new Set(["SPG", "RKLB", "B"]);
      const result = await publishEarningsDate(
        "2026-08-10",
        {
          PIPELINE_EARNINGS_URL: "https://pipeline.test/earnings",
          PIPELINE_AUTH_TOKEN: "tok",
          HTTP_RETRIES: 0,
          runId: () => "run-abc",
          now: () => Date.UTC(2026, 7, 10, 12),
        },
        keep,
      );
      expect(result).toMatchObject({ date: "2026-08-10", row_count: 3, published: true, run_id: "run-abc" });

      expect(posts).toHaveLength(1);
      const post = posts[0];
      expect(post.url).toBe("https://pipeline.test/earnings");
      expect(post.headers["authorization"]).toBe("Bearer tok");
      expect(post.headers["idempotency-key"]).toBe("earnings:run-abc:2026-08-10");
      const rows = post.body as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.symbol).sort()).toEqual(["B", "RKLB", "SPG"]);
      expect(rows[0]).toMatchObject({ run_id: "run-abc", fetched_at: "2026-08-10T12:00:00.000Z" });
      // No nulls ride the wire when the record has them (stripNones).
      const sbs = rows.find((r) => r.symbol === "SBS");
      expect(sbs).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes nothing when the universe filter matches zero rows", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).includes("nasdaq.com")) {
        return new Response(JSON.stringify(NASDAQ_PAYLOAD), { status: 200 });
      }
      throw new Error("should not publish");
    });
    try {
      const result = await publishEarningsDate(
        "2026-08-10",
        { PIPELINE_EARNINGS_URL: "https://pipeline.test/earnings", HTTP_RETRIES: 0, runId: () => "r" },
        new Set(["ZZZ"]),
      );
      expect(result).toMatchObject({ row_count: 0, published: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});