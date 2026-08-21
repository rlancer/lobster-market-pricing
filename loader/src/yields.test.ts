import { describe, expect, it, vi } from "vitest";
import {
  YIELD_SERIES,
  normalizeYieldRecords,
  parseFredObservations,
  publishYieldSeries,
  yieldsSeriesList,
} from "./yields.js";

const FRED_PAYLOAD = {
  observations: [
    { date: "2026-01-02", value: "4.25" },
    { date: "2026-01-03", value: "." },
    { date: "2026-01-06", value: "4.31" },
    { date: "not-a-date", value: "9.99" },
    { date: "2026-01-07", value: "bad" },
  ],
};

describe("yieldsSeriesList", () => {
  it("covers every curated series id", () => {
    const list = yieldsSeriesList();
    expect(list).toEqual(Object.keys(YIELD_SERIES));
    expect(list).toContain("DGS10");
    expect(list).toContain("T10Y2Y");
    expect(list).toContain("SOFR");
  });
});

describe("parseFredObservations", () => {
  it("keeps finite numeric values and skips missing / invalid rows", () => {
    const rows = parseFredObservations("DGS10", FRED_PAYLOAD);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      series_id: "DGS10",
      date: "2026-01-02",
      value: 4.25,
      tenor: "10Y",
      kind: "nominal",
      source: "fred",
      title: YIELD_SERIES.DGS10.title,
    });
    expect(rows[1].date).toBe("2026-01-06");
    expect(rows[1].value).toBe(4.31);
  });

  it("rejects unknown series ids", () => {
    expect(() => parseFredObservations("NOPE", FRED_PAYLOAD)).toThrow(/unknown series_id/);
  });
});

describe("normalizeYieldRecords", () => {
  it("emits schema field order including nullable tenor", () => {
    const rows = parseFredObservations("T10Y2Y", {
      observations: [{ date: "2026-01-02", value: "-0.15" }],
    });
    const [rec] = normalizeYieldRecords(rows, "run-1", "2026-01-02T12:00:00.000Z");
    expect(Object.keys(rec)).toEqual([
      "series_id", "date", "value", "title", "tenor", "kind", "source", "run_id", "fetched_at",
    ]);
    expect(rec).toMatchObject({
      series_id: "T10Y2Y",
      value: -0.15,
      tenor: null,
      kind: "spread",
      run_id: "run-1",
    });
  });
});

describe("publishYieldSeries", () => {
  it("requires PIPELINE_YIELDS_URL", async () => {
    await expect(publishYieldSeries("DGS10")).rejects.toThrow(/PIPELINE_YIELDS_URL/);
  });

  it("fetches, normalizes, and posts observations", async () => {
    const posts: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("stlouisfed.org")) {
        expect(url).toContain("series_id=DGS10");
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
      const result = await publishYieldSeries("DGS10", {
        PIPELINE_YIELDS_URL: "https://pipeline.test/yields",
        PIPELINE_AUTH_TOKEN: "tok",
        FRED_API_KEY: "fredkey",
        HTTP_RETRIES: 0,
        runId: () => "run-abc",
        now: () => Date.parse("2026-08-21T12:00:00.000Z"),
      });
      expect(result).toMatchObject({
        item: "DGS10",
        row_count: 2,
        published: true,
        run_id: "run-abc",
      });
      expect(posts).toHaveLength(1);
      expect(posts[0].headers["idempotency-key"]).toBe("yields:run-abc:DGS10");
      expect(posts[0].headers.authorization).toBe("Bearer tok");
      const rows = posts[0].body as Array<Record<string, unknown>>;
      expect(rows[0]).toMatchObject({
        series_id: "DGS10",
        date: "2026-01-02",
        value: 4.25,
        kind: "nominal",
        source: "fred",
        run_id: "run-abc",
      });
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
      const result = await publishYieldSeries("DGS2", {
        PIPELINE_YIELDS_URL: "https://pipeline.test/yields",
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
      publishYieldSeries("DGS10", {
        PIPELINE_YIELDS_URL: "https://pipeline.test/yields",
        HTTP_RETRIES: 0,
      }),
    ).rejects.toThrow(/FRED_API_KEY/);
  });
});
