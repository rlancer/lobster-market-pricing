import { describe, expect, it, vi } from "vitest";
import {
  SECURITY_TYPES,
  buildInstrumentCatalog,
  normalizeInstrumentRecords,
  publishInstruments,
  securityTypeFromUniverseSource,
} from "./instruments.js";
import { securityIdForTicker } from "./symbology.js";
import etfs from "../symbols/etfs.json";
import universe from "../symbols/universe.json";

describe("securityTypeFromUniverseSource", () => {
  it("maps etf → etf and everything else → equity", () => {
    expect(securityTypeFromUniverseSource("etf")).toBe(SECURITY_TYPES.etf);
    expect(securityTypeFromUniverseSource("sp500")).toBe(SECURITY_TYPES.equity);
    expect(securityTypeFromUniverseSource("nasdaq100")).toBe(SECURITY_TYPES.equity);
    expect(securityTypeFromUniverseSource(undefined)).toBe(SECURITY_TYPES.equity);
  });
});

describe("buildInstrumentCatalog", () => {
  it("tags universe ETFs and equities, plus indexes/futures/crypto", () => {
    const catalog = buildInstrumentCatalog();
    const bySymbol = new Map(catalog.map((r) => [r.symbol, r]));

    expect(bySymbol.get("SPY")).toMatchObject({
      security_type: "etf",
      source: "etf",
      asset_class: "Broad Market",
    });
    expect(bySymbol.get("AAPL")).toMatchObject({
      security_type: "equity",
      source: "sp500",
    });
    expect(bySymbol.get("ASML")).toMatchObject({
      security_type: "equity",
      source: "nasdaq100",
    });
    expect(bySymbol.get("^VIX")).toMatchObject({
      security_type: "index",
      source: "indices",
    });
    expect(bySymbol.get("ES=F")).toMatchObject({
      security_type: "future",
      source: "futures",
    });
    expect(bySymbol.get("BTC-USD")).toMatchObject({
      security_type: "crypto",
      source: "crypto-spot",
      asset_class: "Crypto",
    });

    const etfCount = catalog.filter((r) => r.security_type === "etf").length;
    expect(etfCount).toBe((etfs.etfs as unknown[]).length);
    expect(catalog.length).toBeGreaterThan((universe.symbols as string[]).length);
  });

  it("adds enrolled tickers as equity without overriding bundled symbols", () => {
    const catalog = buildInstrumentCatalog(["SOFI", "spy"]);
    const bySymbol = new Map(catalog.map((r) => [r.symbol, r]));
    expect(bySymbol.get("SOFI")).toMatchObject({
      security_type: "equity",
      source: "enrolled",
    });
    expect(bySymbol.get("SPY")?.security_type).toBe("etf");
  });

  it("tags enrolled funds as etf", () => {
    const catalog = buildInstrumentCatalog(["RSP", "SOFI"], { RSP: "etf", SOFI: "equity" });
    const bySymbol = new Map(catalog.map((r) => [r.symbol, r]));
    expect(bySymbol.get("RSP")).toMatchObject({
      security_type: "etf",
      source: "enrolled",
    });
    expect(bySymbol.get("SOFI")?.security_type).toBe("equity");
  });
});

describe("normalizeInstrumentRecords", () => {
  it("projects security_id + dual symbol/ticker keys", () => {
    const rows = normalizeInstrumentRecords(
      [{ symbol: "spy", name: "SPDR S&P 500 ETF Trust", security_type: "ETF", asset_class: "Broad Market", source: "etf" }],
      "run-1",
      "2026-08-21T12:00:00.000Z",
    );
    expect(rows).toEqual([
      {
        symbol: "SPY",
        ticker: "SPY",
        security_id: securityIdForTicker("SPY"),
        name: "SPDR S&P 500 ETF Trust",
        security_type: "etf",
        asset_class: "Broad Market",
        source: "etf",
        run_id: "run-1",
        as_of_date: "2026-08-21",
        fetched_at: "2026-08-21T12:00:00.000Z",
      },
    ]);
  });
});

describe("publishInstruments", () => {
  it("requires PIPELINE_INSTRUMENTS_URL", async () => {
    await expect(publishInstruments()).rejects.toThrow(/PIPELINE_INSTRUMENTS_URL/);
  });

  it("POSTs the catalog once with auth + idempotency", async () => {
    const posts: Array<{ url: string; body: unknown; headers: Headers }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const result = await publishInstruments(
        {
          PIPELINE_INSTRUMENTS_URL: "https://pipeline.test/instruments",
          PIPELINE_AUTH_TOKEN: "tok",
          HTTP_RETRIES: 0,
          runId: () => "run-inst",
          now: () => new Date("2026-08-21T12:00:00.000Z"),
        },
        ["SOFI"],
      );
      expect(result).toMatchObject({
        published: true,
        run_id: "run-inst",
        row_count: expect.any(Number),
      });
      expect(result.row_count).toBeGreaterThan(600);
      expect(posts).toHaveLength(1);
      expect(posts[0].url).toBe("https://pipeline.test/instruments");
      expect(posts[0].headers.get("authorization")).toBe("Bearer tok");
      expect(posts[0].headers.get("idempotency-key")).toBe("instruments:run-inst");
      const body = posts[0].body as Array<{ symbol: string; security_type: string; run_id: string }>;
      expect(body.every((r) => r.run_id === "run-inst")).toBe(true);
      expect(body.find((r) => r.symbol === "SPY")?.security_type).toBe("etf");
      expect(body.find((r) => r.symbol === "SOFI")?.security_type).toBe("equity");
      expect(body.find((r) => r.symbol === "BTC-USD")?.security_type).toBe("crypto");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
