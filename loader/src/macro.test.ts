import { describe, expect, it, vi } from "vitest";
import {
  MACRO_SERIES,
  normalizeMacroRecords,
  parseFredMacroObservations,
  publishMacroSeries,
  macroSeriesList,
} from "./macro.js";

const FRED_PAYLOAD = {
  observations: [
    { date: "2026-01-01", value: "308.417" },
    { date: "2026-01-02", value: "." },
    { date: "2026-02-01", value: "309.102" },
    { date: "not-a-date", value: "9.99" },
    { date: "2026-03-01", value: "bad" },
  ],
};

describe("macroSeriesList", () => {
  it("covers every curated series id", () => {
    const list = macroSeriesList();
    expect(list).toEqual(Object.keys(MACRO_SERIES));
    expect(list).toContain("CPIAUCSL");
    expect(list).toContain("CPIAUCSL_YOY");
    expect(list).toContain("PCEPILFE");
    expect(list).toContain("PPIFIS");
  });
});

describe("parseFredMacroObservations", () => {
  it("keeps finite numeric values and skips missing / invalid rows", () => {
    const rows = parseFredMacroObservations("CPIAUCSL", FRED_PAYLOAD);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      series_id: "CPIAUCSL",
      date: "2026-01-01",
      value: 308.417,
      kind: "cpi",
      units: "index",
      frequency: "monthly",
      source: "fred",
      title: MACRO_SERIES.CPIAUCSL.title,
    });
    expect(rows[1].date).toBe("2026-02-01");
    expect(rows[1].value).toBe(309.102);
  });

  it("rejects unknown series ids", () => {
    expect(() => parseFredMacroObservations("NOPE", FRED_PAYLOAD)).toThrow(/unknown series_id/);
  });
});

describe("normalizeMacroRecords", () => {
  it("emits schema field order", () => {
    const rows = parseFredMacroObservations("CPIAUCSL_YOY", {
      observations: [{ date: "2026-01-01", value: "3.1" }],
    });
    const [rec] = normalizeMacroRecords(rows, "run-1", "2026-01-02T12:00:00.000Z");
    expect(Object.keys(rec)).toEqual([
      "series_id",
      "date",
      "value",
      "title",
      "kind",
      "units",
      "frequency",
      "source",
      "run_id",
      "fetched_at",
    ]);
    expect(rec).toMatchObject({
      series_id: "CPIAUCSL_YOY",
      value: 3.1,
      kind: "cpi",
      units: "yoy_pct",
      frequency: "monthly",
      run_id: "run-1",
    });
  });
});

describe("publishMacroSeries", () => {
  it("requires PIPELINE_MACRO_URL", async () => {
    await expect(publishMacroSeries("CPIAUCSL")).rejects.toThrow(/PIPELINE_MACRO_URL/);
  });

  it("fetches index levels with units=lin", async () => {
    const posts: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    let fredUrl = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("stlouisfed.org")) {
        fredUrl = url;
        expect(url).toContain("series_id=CPIAUCSL");
        expect(url).toContain("units=lin");
        expect(url).toContain("observation_start=");
        return new Response(JSON.stringify(FRED_PAYLOAD), { status: 200 });
      }
      posts.push({
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const result = await publishMacroSeries("CPIAUCSL", {
        PIPELINE_MACRO_URL: "https://pipeline.test/macro",
        PIPELINE_AUTH_TOKEN: "tok",
        FRED_API_KEY: "fredkey",
        HTTP_RETRIES: 0,
        runId: () => "run-abc",
        now: () => Date.parse("2026-08-21T12:00:00.000Z"),
      });
      expect(result).toMatchObject({
        item: "CPIAUCSL",
        row_count: 2,
        published: true,
        run_id: "run-abc",
      });
      // Default lookback is ~20y (7300d) from fixed now → 2006-08-26.
      expect(fredUrl).toContain("observation_start=2006-08-26");
      expect(fredUrl).toContain("observation_end=2026-08-21");
      expect(posts).toHaveLength(1);
      expect(posts[0].headers["idempotency-key"]).toBe("macro:run-abc:CPIAUCSL");
      expect(posts[0].headers.authorization).toBe("Bearer tok");
      const rows = posts[0].body as Array<Record<string, unknown>>;
      expect(rows[0]).toMatchObject({
        series_id: "CPIAUCSL",
        date: "2026-01-01",
        value: 308.417,
        kind: "cpi",
        units: "index",
        source: "fred",
        run_id: "run-abc",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetches YoY transforms with underlying FRED id + units=pc1", async () => {
    let fredUrl = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("stlouisfed.org")) {
        fredUrl = url;
        return new Response(
          JSON.stringify({ observations: [{ date: "2026-01-01", value: "3.1" }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const result = await publishMacroSeries("CPIAUCSL_YOY", {
        PIPELINE_MACRO_URL: "https://pipeline.test/macro",
        FRED_API_KEY: "fredkey",
        HTTP_RETRIES: 0,
        runId: () => "run-yoy",
      });
      expect(result.published).toBe(true);
      expect(fredUrl).toContain("series_id=CPIAUCSL");
      expect(fredUrl).toContain("units=pc1");
      expect(fredUrl).not.toContain("series_id=CPIAUCSL_YOY");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not publish when a series yields zero rows", async () => {
    let posted = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("stlouisfed.org")) {
        return new Response(JSON.stringify({ observations: [] }), { status: 200 });
      }
      posted += 1;
      return new Response("{}", { status: 200 });
    });
    try {
      const result = await publishMacroSeries("PCEPI", {
        PIPELINE_MACRO_URL: "https://pipeline.test/macro",
        FRED_API_KEY: "fredkey",
        HTTP_RETRIES: 0,
      });
      expect(result.published).toBe(false);
      expect(result.row_count).toBe(0);
      expect(posted).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws when FRED is requested without a key", async () => {
    await expect(
      publishMacroSeries("CPIAUCSL", {
        PIPELINE_MACRO_URL: "https://pipeline.test/macro",
        HTTP_RETRIES: 0,
      }),
    ).rejects.toThrow(/FRED_API_KEY/);
  });
});
