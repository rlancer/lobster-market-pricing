import { describe, expect, it, vi } from "vitest";
import {
  applySeriesCategory,
  buildKalshiAuthHeaders,
  chunkKalshiPipelineRecords,
  collectSportsCombos,
  executorSameGameLegTickers,
  executorTwoLegSportsTickers,
  kalshiAuthConfigured,
  kalshiSeriesList,
  kalshiSignPath,
  keepListedSportsUniverse,
  normalizeKalshiRecords,
  parseKalshiMarketsPayload,
  parseKalshiNumber,
  parseMveCategory,
  publishKalshiSeries,
  rankKalshiMarkets,
  sliceSportsCandleUniverse,
  type KalshiMarketRow,
} from "./kalshi.js";

const SAMPLE_MARKET = {
  ticker: "KXFED-27APR-T4.25",
  event_ticker: "KXFED-27APR",
  title: "Will the upper bound of the federal funds rate be above 4.25%?",
  yes_sub_title: "Above 4.25%",
  status: "active",
  market_type: "binary",
  yes_bid_dollars: "0.1600",
  yes_ask_dollars: "0.3500",
  last_price_dollars: "0.1700",
  no_bid_dollars: "0.6500",
  no_ask_dollars: "0.8400",
  volume_fp: "10251.97",
  volume_24h_fp: "120.00",
  open_interest_fp: "2050.01",
  liquidity_dollars: "10.00",
  floor_strike: 4.25,
  close_time: "2027-04-28T17:55:00Z",
  expiration_time: "2027-05-05T18:05:00Z",
};

async function generateTestPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

describe("kalshi parse helpers", () => {
  it("parseKalshiNumber handles dollar strings and numbers", () => {
    expect(parseKalshiNumber("0.1700")).toBeCloseTo(0.17);
    expect(parseKalshiNumber(0.35)).toBeCloseTo(0.35);
    expect(parseKalshiNumber("")).toBeNull();
    expect(parseKalshiNumber("nope")).toBeNull();
  });

  it("parseKalshiMarketsPayload maps open markets for an allowlisted series", () => {
    const rows = parseKalshiMarketsPayload("KXFED", { markets: [SAMPLE_MARKET] });
    expect(rows).toHaveLength(1);
    expect(rows[0].series_ticker).toBe("KXFED");
    expect(rows[0].market_ticker).toBe("KXFED-27APR-T4.25");
    expect(rows[0].theme).toBe("rates");
    expect(rows[0].related_symbol).toBe("TLT");
    expect(rows[0].yes_bid).toBeCloseTo(0.16);
    expect(rows[0].yes_ask).toBeCloseTo(0.35);
    expect(rows[0].floor_strike).toBe(4.25);
    expect(rows[0].source).toBe("kalshi");
  });

  it("rejects unknown series tickers", () => {
    expect(() => parseKalshiMarketsPayload("KXSPORTS", { markets: [] })).toThrow(/unknown series/);
  });

  it("rankKalshiMarkets prefers higher 24h volume then sooner close", () => {
    const base: KalshiMarketRow = {
      series_ticker: "KXFED",
      market_ticker: "A",
      event_ticker: null,
      title: "a",
      yes_subtitle: null,
      theme: "rates",
      category: null,
      status: "active",
      market_type: "binary",
      yes_bid: 0.1,
      yes_ask: 0.2,
      yes_last: 0.15,
      no_bid: null,
      no_ask: null,
      volume: 1,
      volume_24h: 10,
      open_interest: null,
      liquidity: null,
      floor_strike: null,
      close_time: "2026-09-01T00:00:00Z",
      expiration_time: null,
      related_symbol: "TLT",
      source: "kalshi",
    };
    const ranked = rankKalshiMarkets([
      { ...base, market_ticker: "LOW", volume_24h: 1, close_time: "2026-08-01T00:00:00Z" },
      { ...base, market_ticker: "HIGH", volume_24h: 99, close_time: "2026-12-01T00:00:00Z" },
      { ...base, market_ticker: "MID", volume_24h: 10, close_time: "2026-08-15T00:00:00Z" },
    ]);
    expect(ranked.map((r) => r.market_ticker)).toEqual(["HIGH", "MID", "LOW"]);
  });

  it("applySeriesCategory denormalizes category onto rows", () => {
    const rows = parseKalshiMarketsPayload("KXFED", { markets: [SAMPLE_MARKET] });
    const enriched = applySeriesCategory(rows, { series: { category: "Economics" } });
    expect(enriched[0].category).toBe("Economics");
  });

  it("normalizeKalshiRecords keeps schema fields and provenance", () => {
    const rows = parseKalshiMarketsPayload("KXFED", { markets: [SAMPLE_MARKET] });
    const out = normalizeKalshiRecords(rows, "run-1", "2026-08-22T00:00:00.000Z");
    expect(out[0].run_id).toBe("run-1");
    expect(out[0].fetched_at).toBe("2026-08-22T00:00:00.000Z");
    expect(out[0].market_ticker).toBe("KXFED-27APR-T4.25");
  });

  it("normalizeKalshiRecords keeps per-row fetched_at for candle history", () => {
    const rows = parseKalshiMarketsPayload("KXFED", { markets: [SAMPLE_MARKET] });
    rows[0].fetched_at = "2026-08-01T00:00:00.000Z";
    const out = normalizeKalshiRecords(rows, "run-1", "2026-08-22T00:00:00.000Z");
    expect(out[0].fetched_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("kalshiSeriesList exposes the curated allowlist including sports parlays", () => {
    const list = kalshiSeriesList();
    expect(list).toContain("KXFED");
    expect(list).toContain("KXCPI");
    expect(list).toContain("KXINX");
    expect(list).toContain("KXBTC");
    expect(list).toContain("KXMVE");
    expect(list).not.toContain("KXSPORTS");
  });
});

function noiseCombo(i: number) {
  return {
    ticker: `KXMVECROSSCATEGORY-NOISE${String(i).padStart(3, "0")}`,
    series_ticker: "KXMVE",
    title: `Noise ${i}`,
    status: "active",
    mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
    mve_selected_legs: [
      { event_ticker: "KXNFLGAME-26SEP13AAA", market_ticker: `KXNFLGAME-26SEP13AAA-A${i}`, side: "yes" },
      { event_ticker: "KXNFLGAME-26SEP13BBB", market_ticker: `KXNFLGAME-26SEP13BBB-B${i}`, side: "yes" },
      { event_ticker: "KXNFLGAME-26SEP13CCC", market_ticker: `KXNFLGAME-26SEP13CCC-C${i}`, side: "yes" },
    ],
    volume_fp: "1000",
    volume_24h_fp: "500",
    close_time: "2026-09-14T00:00:00Z",
  };
}

const VOL0_SAME_GAME = {
  ticker: "KXMLBOUTS-26SEP142138SEALAA",
  series_ticker: "KXMVE",
  title: "Detmers 18+ AND Anderson 16+",
  status: "active",
  mve_collection_ticker: "KXMLBOUTS",
  mve_selected_legs: [
    { event_ticker: "KXMLBOUTS-26SEP142138SEALAA", market_ticker: "KXMLBOUTS-26SEP142138SEALAA-DETMERS18", side: "yes" },
    { event_ticker: "KXMLBOUTS-26SEP142138SEALAA", market_ticker: "KXMLBOUTS-26SEP142138SEALAA-ANDERSON16", side: "yes" },
  ],
  volume_fp: "0",
  volume_24h_fp: "0",
  close_time: "2026-09-14T00:00:00Z",
};

const VOL0_CROSS_GAME = {
  ticker: "KXMVE-KC-TB",
  series_ticker: "KXMVE",
  title: "KC -2.5 AND TB -27.5",
  status: "active",
  mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
  mve_selected_legs: [
    { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLSPREAD-26SEP13KCDEN-KC2", side: "yes" },
    { event_ticker: "KXNFLGAME-26SEP13TB", market_ticker: "KXNFLSPREAD-26SEP13TBCLE-TB27", side: "yes" },
  ],
  volume_fp: "0",
  volume_24h_fp: "0",
  close_time: "2026-09-14T00:00:00Z",
};

describe("sports combo universe vs lake cap", () => {
  it("hourly listed universe keeps volume-0 two-legs; n>2 noise is not the parlay tape; executor scan stays uncapped", () => {
    const raw = [...Array.from({ length: 80 }, (_, i) => noiseCombo(i)), VOL0_SAME_GAME, VOL0_CROSS_GAME];
    const investing = new Set<string>();
    const all = collectSportsCombos(raw, investing, null);
    const listed = keepListedSportsUniverse(all);
    const capped = collectSportsCombos(raw, investing, 80);
    expect(all.ranked).toHaveLength(82);
    expect(listed.ranked).toHaveLength(2);
    expect(listed.ranked.map((row) => row.market_ticker)).toEqual(
      expect.arrayContaining([VOL0_SAME_GAME.ticker, VOL0_CROSS_GAME.ticker]),
    );
    expect(listed.ranked.map((row) => row.market_ticker)).not.toContain(noiseCombo(0).ticker);
    expect(capped.ranked).toHaveLength(80);
    expect(capped.ranked.map((row) => row.market_ticker)).not.toContain(VOL0_SAME_GAME.ticker);
    const comboTickers = new Set(all.ranked.map((row) => row.market_ticker));
    expect(executorSameGameLegTickers(all.comboLegs, comboTickers)).toEqual([
      "KXMLBOUTS-26SEP142138SEALAA-DETMERS18",
      "KXMLBOUTS-26SEP142138SEALAA-ANDERSON16",
    ]);
    expect(executorTwoLegSportsTickers(all.comboLegs, comboTickers, "cross_game")).toEqual([
      "KXNFLSPREAD-26SEP13KCDEN-KC2",
      "KXNFLSPREAD-26SEP13TBCLE-TB27",
    ]);
    expect(executorSameGameLegTickers(listed.comboLegs, new Set(listed.ranked.map((row) => row.market_ticker)))).toEqual([
      "KXMLBOUTS-26SEP142138SEALAA-DETMERS18",
      "KXMLBOUTS-26SEP142138SEALAA-ANDERSON16",
    ]);
  });

  it("pins an RFQ/fill ticker that is outside the volume candle cap", () => {
    const raw = [...Array.from({ length: 80 }, (_, i) => noiseCombo(i)), VOL0_SAME_GAME];
    const all = collectSportsCombos(raw, new Set(), null);
    const listed = keepListedSportsUniverse(all, new Set([VOL0_SAME_GAME.ticker, noiseCombo(0).ticker]));
    expect(listed.ranked.map((row) => row.market_ticker)).toContain(VOL0_SAME_GAME.ticker);
    expect(listed.ranked.map((row) => row.market_ticker)).toContain(noiseCombo(0).ticker);
    const candles = sliceSportsCandleUniverse(listed, 1);
    expect(candles.ranked).toHaveLength(1);
    expect(candles.ranked[0].market_ticker).toBe(noiseCombo(0).ticker);
  });
});

describe("publishKalshiSeries", () => {
  it("requires PIPELINE_KALSHI_MARKETS_URL", async () => {
    await expect(publishKalshiSeries("KXFED")).rejects.toThrow(/PIPELINE_KALSHI_MARKETS_URL/);
  });

  it("fetches open markets, caps, and posts to the pipeline", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/series/KXFED")) {
        return new Response(JSON.stringify({ series: { category: "Economics", ticker: "KXFED" } }), {
          status: 200,
        });
      }
      if (url.includes("/markets?") && url.includes("series_ticker=KXFED")) {
        return new Response(JSON.stringify({ markets: [SAMPLE_MARKET], cursor: "" }), { status: 200 });
      }
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    try {
      const result = await publishKalshiSeries("KXFED", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_FETCH_SERIES_META: "1",
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        runId: () => "run-kalshi",
      });
      expect(result.published).toBe(true);
      expect(result.row_count).toBe(1);
      expect(result.run_id).toBe("run-kalshi");
      expect(posts).toHaveLength(1);
      const body = posts[0] as Array<Record<string, unknown>>;
      expect(body[0].category).toBe("Economics");
      expect(body[0].source).toBe("kalshi");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips publish when a series has no open markets", async () => {
    let posted = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/series/")) {
        return new Response(JSON.stringify({ series: { category: "Economics" } }), { status: 200 });
      }
      if (url.includes("/markets?")) {
        return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
      }
      if (init?.method === "POST") {
        posted += 1;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    try {
      const result = await publishKalshiSeries("KXFED", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        runId: () => "run-empty",
      });
      expect(result.published).toBe(false);
      expect(result.row_count).toBe(0);
      expect(posted).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("attaches KALSHI-ACCESS-* headers when API key secrets are set", async () => {
    const pem = await generateTestPem();
    const seen: Record<string, string>[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/markets?")) {
        const h = init?.headers as Record<string, string>;
        seen.push(h || {});
        return new Response(JSON.stringify({ markets: [SAMPLE_MARKET], cursor: "" }), { status: 200 });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    try {
      await publishKalshiSeries("KXFED", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        KALSHI_ACCESS_KEY_ID: "test-key-id",
        KALSHI_PRIVATE_KEY_PEM: pem,
        now: () => 1_700_000_000_000,
        runId: () => "run-auth",
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]["KALSHI-ACCESS-KEY"]).toBe("test-key-id");
      expect(seen[0]["KALSHI-ACCESS-TIMESTAMP"]).toBe("1700000000000");
      expect(seen[0]["KALSHI-ACCESS-SIGNATURE"]).toMatch(/^[A-Za-z0-9+/=]+$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("chunks pipeline POSTs so each body stays under the ingest cap", async () => {
    const posts: unknown[] = [];
    const markets = Array.from({ length: 6 }, (_, i) => ({
      ...SAMPLE_MARKET,
      ticker: `KXFED-CHUNK-${i}`,
      title: `Will the rate be above 4.25% pad-${"x".repeat(80)}-${i}?`,
    }));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/series/KXFED")) {
        return new Response(JSON.stringify({ series: { category: "Economics", ticker: "KXFED" } }), {
          status: 200,
        });
      }
      if (url.includes("/markets?") && url.includes("series_ticker=KXFED")) {
        return new Response(JSON.stringify({ markets, cursor: "" }), { status: 200 });
      }
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    try {
      const result = await publishKalshiSeries("KXFED", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_FETCH_SERIES_META: "1",
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        KALSHI_PIPELINE_MAX_BODY_BYTES: 900,
        runId: () => "run-chunk",
      });
      expect(result.published).toBe(true);
      expect(result.row_count).toBe(6);
      expect(posts.length).toBeGreaterThan(1);
      expect(posts.reduce((n, body) => n + (body as unknown[]).length, 0)).toBe(6);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("chunkKalshiPipelineRecords", () => {
  it("keeps a small batch in one chunk and splits when over budget", () => {
    const small = [{ a: 1 }, { a: 2 }];
    expect(chunkKalshiPipelineRecords(small, 10_000)).toEqual([small]);
    const rows = Array.from({ length: 8 }, (_, i) => ({ ticker: `T${i}`, pad: "n".repeat(40) }));
    const chunks = chunkKalshiPipelineRecords(rows, 180);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toHaveLength(8);
    for (const chunk of chunks) {
      expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(180);
    }
  });
});

describe("kalshi auth helpers", () => {
  it("kalshiSignPath strips query and keeps /trade-api path", () => {
    expect(kalshiSignPath("https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXFED"))
      .toBe("/trade-api/v2/markets");
  });

  it("kalshiAuthConfigured requires both key id and pem", () => {
    expect(kalshiAuthConfigured({})).toBe(false);
    expect(kalshiAuthConfigured({ KALSHI_ACCESS_KEY_ID: "x" })).toBe(false);
    expect(kalshiAuthConfigured({ KALSHI_PRIVATE_KEY_PEM: "y" })).toBe(false);
    expect(kalshiAuthConfigured({ KALSHI_ACCESS_KEY_ID: "x", KALSHI_PRIVATE_KEY_PEM: "y" })).toBe(true);
  });

  it("buildKalshiAuthHeaders signs timestamp+METHOD+path", async () => {
    const pem = await generateTestPem();
    const headers = await buildKalshiAuthHeaders(
      "GET",
      "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXFED",
      {
        KALSHI_ACCESS_KEY_ID: "abc",
        KALSHI_PRIVATE_KEY_PEM: pem,
        now: () => 1_700_000_000_123,
      },
    );
    expect(headers).not.toBeNull();
    expect(headers!["KALSHI-ACCESS-KEY"]).toBe("abc");
    expect(headers!["KALSHI-ACCESS-TIMESTAMP"]).toBe("1700000000123");
    expect(headers!["KALSHI-ACCESS-SIGNATURE"].length).toBeGreaterThan(40);
  });
});

const NFL_COMBO = {
  ticker: "KXNFLPARLAY-26SEP13-KCBUF",
  event_ticker: "KXNFLPARLAY-26SEP13",
  series_ticker: "KXNFLPARLAY",
  title: "Chiefs win AND Bills win",
  category: "Sports",
  status: "active",
  market_type: "binary",
  mve_collection_ticker: "KXMVESPORT-NFL",
  mve_selected_legs: [
    { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-KC", side: "yes" },
    { event_ticker: "KXNFLGAME-26SEP13BUF", market_ticker: "KXNFLGAME-26SEP13BUF-BUF", side: "yes" },
  ],
  yes_bid_dollars: "0.20",
  yes_ask_dollars: "0.24",
  last_price_dollars: "0.22",
  volume_fp: "500",
  volume_24h_fp: "80",
  close_time: "2026-09-14T00:00:00Z",
};

const NFL_LEG_KC = {
  ticker: "KXNFLGAME-26SEP13KC-KC",
  event_ticker: "KXNFLGAME-26SEP13KC",
  series_ticker: "KXNFLGAME",
  title: "Chiefs win",
  status: "active",
  yes_bid_dollars: "0.55",
  yes_ask_dollars: "0.57",
  last_price_dollars: "0.56",
  volume_fp: "9000",
  close_time: "2026-09-14T00:00:00Z",
};

const NFL_LEG_BUF = {
  ticker: "KXNFLGAME-26SEP13BUF-BUF",
  event_ticker: "KXNFLGAME-26SEP13BUF",
  series_ticker: "KXNFLGAME",
  title: "Bills win",
  status: "active",
  yes_bid_dollars: "0.48",
  yes_ask_dollars: "0.50",
  last_price_dollars: "0.49",
  volume_fp: "8000",
  close_time: "2026-09-14T00:00:00Z",
};

describe("publishKalshiSeries sports parlays", () => {
  it("publishes MVE combos with encoded legs plus the selected leg books", async () => {
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("mve_filter=only")) {
        return new Response(JSON.stringify({ markets: [NFL_COMBO], cursor: "" }), { status: 200 });
      }
      if (url.includes("tickers=")) {
        return new Response(JSON.stringify({ markets: [NFL_LEG_KC, NFL_LEG_BUF], cursor: "" }), { status: 200 });
      }
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("unexpected " + url, { status: 500 });
    });
    try {
      const result = await publishKalshiSeries("KXMVE", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        KALSHI_SPORTS_LOOKBACK_DAYS: 0,
        runId: () => "run-mve",
      });
      expect(result.published).toBe(true);
      expect(result.row_count).toBe(3);
      const body = posts[0] as Array<Record<string, unknown>>;
      const combo = body.find((r) => r.market_ticker === "KXNFLPARLAY-26SEP13-KCBUF");
      const kc = body.find((r) => r.market_ticker === "KXNFLGAME-26SEP13KC-KC");
      expect(combo?.theme).toBe("sports");
      expect(combo?.market_type).toBe("multivariate");
      const parsed = parseMveCategory(String(combo?.category || ""));
      expect(parsed?.legs).toHaveLength(2);
      expect(parsed?.legs[0]?.event_ticker).toBe("KXNFLGAME-26SEP13KC");
      expect(kc?.theme).toBe("sports");
      expect(kc?.series_ticker).toBe("KXNFLGAME");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes volume-0 two-leg sports books and skips n>2 noise", async () => {
    const posts: unknown[] = [];
    const noise = Array.from({ length: 80 }, (_, i) => noiseCombo(i));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("mve_filter=only")) {
        return new Response(JSON.stringify({
          markets: [...noise, VOL0_SAME_GAME, VOL0_CROSS_GAME],
          cursor: "",
        }), { status: 200 });
      }
      if (url.includes("tickers=")) {
        return new Response(JSON.stringify({
          markets: [
            { ticker: "KXMLBOUTS-26SEP142138SEALAA-DETMERS18", series_ticker: "KXMLBOUTS", title: "Detmers 18+", status: "active" },
            { ticker: "KXMLBOUTS-26SEP142138SEALAA-ANDERSON16", series_ticker: "KXMLBOUTS", title: "Anderson 16+", status: "active" },
            { ticker: "KXNFLSPREAD-26SEP13KCDEN-KC2", series_ticker: "KXNFLSPREAD", title: "KC -2.5", status: "active" },
            { ticker: "KXNFLSPREAD-26SEP13TBCLE-TB27", series_ticker: "KXNFLSPREAD", title: "TB -27.5", status: "active" },
          ],
          cursor: "",
        }), { status: 200 });
      }
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("unexpected " + url, { status: 500 });
    });
    try {
      const result = await publishKalshiSeries("KXMVE", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        KALSHI_SPORTS_LOOKBACK_DAYS: 0,
        runId: () => "run-mve-vol0",
      });
      expect(result.published).toBe(true);
      const body = (posts[0] as Array<Record<string, unknown>>);
      const tickers = body.map((r) => r.market_ticker);
      expect(tickers).toContain(VOL0_SAME_GAME.ticker);
      expect(tickers).toContain(VOL0_CROSS_GAME.ticker);
      expect(tickers).not.toContain(noiseCombo(0).ticker);
      expect(body.filter((r) => r.market_type === "multivariate")).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("emits settlement 0/1 for a volume-0 two-leg outside the candle cap", async () => {
    const posts: unknown[] = [];
    const loud = Array.from({ length: 5 }, (_, i) => ({
      ticker: `KXNFLPARLAY-26AUG-LOUD${i}`,
      series_ticker: "KXNFLPARLAY",
      title: `Loud ${i}`,
      status: "settled",
      result: "yes",
      last_price_dollars: "1.00",
      yes_bid_dollars: "1.00",
      yes_ask_dollars: "1.00",
      mve_collection_ticker: "KXMVESPORT-NFL",
      mve_selected_legs: [
        { event_ticker: `KXNFLGAME-26AUG${i}AAA`, market_ticker: `KXNFLGAME-26AUG${i}AAA-A`, side: "yes" },
        { event_ticker: `KXNFLGAME-26AUG${i}BBB`, market_ticker: `KXNFLGAME-26AUG${i}BBB-B`, side: "yes" },
      ],
      volume_fp: "9000",
      volume_24h_fp: "9000",
      close_time: "2026-08-17T00:00:00Z",
    }));
    const quiet = {
      ticker: "KXMLBOUTS-26AUG-QUIET",
      series_ticker: "KXMLBOUTS",
      title: "Quiet two-leg",
      status: "settled",
      result: "no",
      last_price_dollars: "0.00",
      yes_bid_dollars: "0.00",
      yes_ask_dollars: "0.00",
      mve_collection_ticker: "KXMLBOUTS",
      mve_selected_legs: [
        { event_ticker: "KXMLBOUTS-26AUG-SEA", market_ticker: "KXMLBOUTS-26AUG-SEA-A", side: "yes" },
        { event_ticker: "KXMLBOUTS-26AUG-SEA", market_ticker: "KXMLBOUTS-26AUG-SEA-B", side: "yes" },
      ],
      volume_fp: "0",
      volume_24h_fp: "0",
      close_time: "2026-08-17T00:00:00Z",
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/markets/candlesticks")) {
        return new Response(JSON.stringify({ markets: [] }), { status: 200 });
      }
      if (url.includes("mve_filter=only") && url.includes("status=open")) {
        return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
      }
      if (url.includes("mve_filter=only") && url.includes("status=settled")) {
        return new Response(JSON.stringify({ markets: [...loud, quiet], cursor: "" }), { status: 200 });
      }
      if (url.includes("mve_filter=only") && url.includes("status=closed")) {
        return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
      }
      if (url.includes("tickers=")) {
        return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
      }
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("unexpected " + url, { status: 500 });
    });
    try {
      const result = await publishKalshiSeries("KXMVE", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        KALSHI_SPORTS_LOOKBACK_DAYS: 30,
        KALSHI_SPORTS_LOOKBACK_MAX: 3,
        now: () => Date.parse("2026-09-13T17:00:00.000Z"),
        runId: () => "run-mve-settle-pin",
      });
      expect(result.published).toBe(true);
      const body = posts.flatMap((chunk) => chunk as Array<Record<string, unknown>>);
      const quietSettle = body.find((r) =>
        r.market_ticker === "KXMLBOUTS-26AUG-QUIET" && r.source === "kalshi_settlement"
      );
      expect(quietSettle?.yes_last).toBe(0);
      expect(body.filter((r) => r.source === "kalshi_settlement")).toHaveLength(6);
      expect(body.some((r) => r.market_ticker === "KXMLBOUTS-26AUG-QUIET" && r.source === "kalshi")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not ingest investing series that appear on the MVE endpoint", async () => {
    const posts: unknown[] = [];
    const fedCombo = {
      ticker: "KXFEDCOMBO-26SEPB-25H-T0",
      series_ticker: "KXFEDCOMBO",
      title: "hike AND dissents",
      category: "Economics",
      status: "active",
      mve_collection_ticker: "KXFEDCOMBO",
      mve_selected_legs: [
        { event_ticker: "KXFEDDECISION-26SEP", market_ticker: "KXFEDDECISION-26SEP-H25", side: "yes" },
        { event_ticker: "KXFOMCDISSENTCOUNT-26SEP", market_ticker: "KXFOMCDISSENTCOUNT-26SEP-0", side: "yes" },
      ],
      yes_bid_dollars: "0.61",
      yes_ask_dollars: "0.62",
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("mve_filter=only")) {
        return new Response(JSON.stringify({ markets: [fedCombo], cursor: "" }), { status: 200 });
      }
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("unexpected " + url, { status: 500 });
    });
    try {
      const result = await publishKalshiSeries("KXMVE", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        KALSHI_SPORTS_LOOKBACK_DAYS: 0,
        runId: () => "run-mve-skip",
      });
      expect(result.published).toBe(false);
      expect(result.row_count).toBe(0);
      expect(posts).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("backfills ~30d of daily candles and skips settlement 0/1 snapshots", async () => {
    const urls: string[] = [];
    const posts: unknown[] = [];
    const settledCombo = {
      ticker: "KXNFLPARLAY-26AUG16-DALNYG",
      event_ticker: "KXNFLPARLAY-26AUG16",
      series_ticker: "KXNFLPARLAY",
      title: "Cowboys win AND Giants win",
      category: "Sports",
      status: "settled",
      market_type: "binary",
      mve_collection_ticker: "KXMVESPORT-NFL",
      mve_selected_legs: [
        { event_ticker: "KXNFLGAME-26AUG16DAL", market_ticker: "KXNFLGAME-26AUG16DAL-DAL", side: "yes" },
        { event_ticker: "KXNFLGAME-26AUG16NYG", market_ticker: "KXNFLGAME-26AUG16NYG-NYG", side: "yes" },
      ],
      yes_bid_dollars: "1.00",
      yes_ask_dollars: "1.00",
      last_price_dollars: "1.00",
      volume_fp: "800",
      volume_24h_fp: "0",
      close_time: "2026-08-17T00:00:00Z",
    };
    const settledLegDal = {
      ticker: "KXNFLGAME-26AUG16DAL-DAL",
      event_ticker: "KXNFLGAME-26AUG16DAL",
      series_ticker: "KXNFLGAME",
      title: "Cowboys win",
      status: "settled",
      yes_bid_dollars: "1.00",
      yes_ask_dollars: "1.00",
      last_price_dollars: "1.00",
      volume_fp: "9000",
      close_time: "2026-08-17T00:00:00Z",
    };
    const settledLegNyg = {
      ticker: "KXNFLGAME-26AUG16NYG-NYG",
      event_ticker: "KXNFLGAME-26AUG16NYG",
      series_ticker: "KXNFLGAME",
      title: "Giants win",
      status: "settled",
      yes_bid_dollars: "0.00",
      yes_ask_dollars: "0.00",
      last_price_dollars: "0.00",
      volume_fp: "8000",
      close_time: "2026-08-17T00:00:00Z",
    };
    const candleTs = Math.floor(Date.parse("2026-08-16T00:00:00.000Z") / 1000);
    const candleIso = new Date(candleTs * 1000).toISOString();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/markets/candlesticks")) {
        return new Response(JSON.stringify({
          markets: [
            {
              market_ticker: "KXNFLPARLAY-26AUG16-DALNYG",
              candlesticks: [
                {
                  end_period_ts: candleTs,
                  yes_bid: { close_dollars: "0.18" },
                  yes_ask: { close_dollars: "0.22" },
                  price: { close_dollars: "0.20" },
                  volume_fp: "120.00",
                  open_interest_fp: "40.00",
                },
                {
                  end_period_ts: candleTs + 86400,
                  yes_bid: { close_dollars: "1.00" },
                  yes_ask: { close_dollars: "1.00" },
                  price: { close_dollars: "1.00" },
                  volume_fp: "10.00",
                  open_interest_fp: "40.00",
                },
              ],
            },
            {
              market_ticker: "KXNFLGAME-26AUG16DAL-DAL",
              candlesticks: [{
                end_period_ts: candleTs,
                yes_bid: { close_dollars: "0.62" },
                yes_ask: { close_dollars: "0.64" },
                price: { close_dollars: "0.63" },
                volume_fp: "400.00",
                open_interest_fp: "200.00",
              }],
            },
            {
              market_ticker: "KXNFLGAME-26AUG16NYG-NYG",
              candlesticks: [{
                end_period_ts: candleTs,
                yes_bid: { close_dollars: "0.31" },
                yes_ask: { close_dollars: "0.33" },
                price: { close_dollars: "0.32" },
                volume_fp: "300.00",
                open_interest_fp: "150.00",
              }],
            },
          ],
        }), { status: 200 });
      }
      if (url.includes("mve_filter=only") && url.includes("status=open")) {
        return new Response(JSON.stringify({ markets: [NFL_COMBO], cursor: "" }), { status: 200 });
      }
      if (url.includes("mve_filter=only") && url.includes("status=settled")) {
        return new Response(JSON.stringify({ markets: [settledCombo], cursor: "" }), { status: 200 });
      }
      if (url.includes("mve_filter=only") && url.includes("status=closed")) {
        return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
      }
      if (url.includes("tickers=")) {
        return new Response(JSON.stringify({
          markets: [NFL_LEG_KC, NFL_LEG_BUF, settledLegDal, settledLegNyg],
          cursor: "",
        }), { status: 200 });
      }
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("unexpected " + url, { status: 500 });
    });
    try {
      const result = await publishKalshiSeries("KXMVE", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        KALSHI_SPORTS_LOOKBACK_DAYS: 30,
        now: () => Date.parse("2026-09-13T17:00:00.000Z"),
        runId: () => "run-mve-backfill",
      });
      expect(result.published).toBe(true);
      const settledUrl = urls.find((u) => u.includes("status=settled"));
      expect(settledUrl).toMatch(/min_settled_ts=\d+/);
      const settledTs = Number(new URL(settledUrl!).searchParams.get("min_settled_ts"));
      expect(settledTs).toBeGreaterThan(Math.floor(Date.now() / 1000) - 31 * 86400);
      expect(settledTs).toBeLessThan(Math.floor(Date.now() / 1000) - 29 * 86400);
      expect(urls.some((u) => u.includes("status=closed") && u.includes("min_close_ts="))).toBe(true);
      expect(urls.some((u) => u.includes("/markets/candlesticks") && u.includes("period_interval=1440"))).toBe(true);
      const body = posts[0] as Array<Record<string, unknown>>;
      const liveCombo = body.find((r) => r.market_ticker === "KXNFLPARLAY-26SEP13-KCBUF" && r.fetched_at === "2026-09-13T17:00:00.000Z");
      expect(liveCombo?.yes_last).toBeCloseTo(0.22);
      const settledLive = body.find((r) => r.market_ticker === "KXNFLPARLAY-26AUG16-DALNYG" && r.fetched_at === "2026-09-13T17:00:00.000Z");
      expect(settledLive).toBeUndefined();
      const settledCandle = body.find((r) => r.market_ticker === "KXNFLPARLAY-26AUG16-DALNYG" && r.fetched_at === candleIso);
      expect(settledCandle?.yes_last).toBeCloseTo(0.20);
      expect(settledCandle?.yes_bid).toBeCloseTo(0.18);
      expect(settledCandle?.status).toBe("settled");
      const settlementPrint = body.find((r) => r.market_ticker === "KXNFLPARLAY-26AUG16-DALNYG" && r.yes_last === 1);
      expect(settlementPrint?.source).toBe("kalshi_settlement");
      expect(settlementPrint?.fetched_at).toBe("2026-08-17T00:00:00Z");
      const dalSettle = body.find((r) => r.market_ticker === "KXNFLGAME-26AUG16DAL-DAL" && r.source === "kalshi_settlement");
      const nygSettle = body.find((r) => r.market_ticker === "KXNFLGAME-26AUG16NYG-NYG" && r.source === "kalshi_settlement");
      expect(dalSettle?.yes_last).toBe(1);
      expect(nygSettle?.yes_last).toBe(0);
      const settlementCandle = body.find((r) =>
        r.market_ticker === "KXNFLPARLAY-26AUG16-DALNYG"
        && r.fetched_at !== "2026-08-17T00:00:00Z"
        && r.yes_last === 1
      );
      expect(settlementCandle).toBeUndefined();
      expect(body.some((r) => r.market_ticker === "KXNFLGAME-26AUG16DAL-DAL" && r.fetched_at === candleIso)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

