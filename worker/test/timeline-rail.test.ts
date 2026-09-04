import assert from "node:assert/strict";
import test from "node:test";
import {
  chatNewsQuery,
  highlightsFromOhlcRows,
  highlightsFromVxQuoteRows,
  loadChatRail,
  loadTimelineRail,
  marketHighlightSql,
  nearMonthVxSql,
  parseTavilyNewsResults,
  pctChange,
  rankTimelineTags,
  resetTimelineRailCache,
  tagsFromChatTickers,
  TIMELINE_RAIL_NEWS_QUERY,
  vxFuturesDisplayName,
  type TimelineRailEnv,
} from "../src/timeline-rail.ts";

test("pctChange is null for missing or zero bases", () => {
  assert.equal(pctChange(null, 10), null);
  assert.equal(pctChange(0, 10), null);
  assert.equal(pctChange(100, 110), 10);
  assert.equal(pctChange(200, 180), -10);
});

test("rankTimelineTags uppercases, drops empties, and orders by posts", () => {
  assert.deepEqual(
    rankTimelineTags([
      { ticker: " spy ", posts: 2 },
      { ticker: "QQQ", posts: 5 },
      { ticker: "", posts: 9 },
      { ticker: "IWM", posts: 5 },
      { ticker: "DIA", posts: 0 },
    ]),
    [
      { ticker: "IWM", posts: 5 },
      { ticker: "QQQ", posts: 5 },
      { ticker: "SPY", posts: 2 },
    ],
  );
});

test("highlightsFromOhlcRows keep watchlist order and compute 1d change", () => {
  const items = highlightsFromOhlcRows([
    { symbol: "spy", spot: 510, prev_close: 500 },
    { ticker: "QQQ", close: 440, prev_close: 400 },
    { symbol: "DIA", spot: 390, prev_close: 400 },
  ]);
  assert.equal(items[0]?.ticker, "SPY");
  assert.equal(items[0]?.spot, 510);
  assert.equal(items[0]?.change_1d_pct, 2);
  assert.equal(items[1]?.ticker, "QQQ");
  assert.equal(items[1]?.change_1d_pct, 10);
  assert.equal(items[2]?.ticker, "IWM");
  assert.equal(items[2]?.spot, null);
  assert.equal(items[3]?.ticker, "DIA");
  assert.equal(items[3]?.change_1d_pct, -2.5);
  assert.equal(items.length, 4);
});

test("vxFuturesDisplayName maps CFE month codes", () => {
  assert.equal(vxFuturesDisplayName("VXU26"), "VX Sep'26");
  assert.equal(vxFuturesDisplayName("vxf27"), "VX Jan'27");
  assert.equal(vxFuturesDisplayName("OTHER"), "OTHER");
});

test("highlightsFromVxQuoteRows take the nearest two monthals", () => {
  const items = highlightsFromVxQuoteRows([
    { symbol: "VXU26", last: 16.4, prev_close: 17 },
    { contract_symbol: "VXV26", close: 17.2, prev_close: 17 },
    { symbol: "VXX26", last: 18, prev_close: 18 },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.ticker, "VXU26");
  assert.equal(items[0]?.name, "VX Sep'26");
  assert.equal(items[0]?.spot, 16.4);
  assert.ok(items[0]?.change_1d_pct != null && items[0]!.change_1d_pct! < 0);
  assert.equal(items[1]?.ticker, "VXV26");
  assert.equal(items[1]?.spot, 17.2);
});

test("parseTavilyNewsResults keeps titled links and caps the list", () => {
  const items = parseTavilyNewsResults({
    results: [
      { title: "  Open higher  ", url: "https://example.com/a", content: "Futures bid." },
      { title: "", url: "https://example.com/skip" },
      { title: "No link" },
      { title: "Second", url: "https://example.com/b", published_date: "2026-08-19" },
    ],
  }, 8);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.title, "Open higher");
  assert.equal(items[0]?.source, "tavily");
  assert.equal(items[1]?.published, "2026-08-19");
});

test("marketHighlightSql pins the tape symbols and a date bound", () => {
  const sql = marketHighlightSql("2026-08-05");
  assert.match(sql, /symbol IN \('SPY', 'QQQ', 'IWM', 'DIA'\)/);
  assert.doesNotMatch(sql, /\^VIX/);
  assert.match(sql, /date >= '2026-08-05'/);
  assert.match(sql, /FROM options\.ohlc/);
});

test("nearMonthVxSql pins root VX and an expiration floor", () => {
  const sql = nearMonthVxSql("2026-09-04");
  assert.match(sql, /FROM options\.futures_quotes/);
  assert.match(sql, /root = 'VX'/);
  assert.match(sql, /expiration_date >= '2026-09-04'/);
  assert.match(sql, /LIMIT 2/);
});

test("marketHighlightSql accepts a custom watchlist", () => {
  const sql = marketHighlightSql("2026-08-05", [
    { ticker: "NVDA", name: "NVIDIA" },
    { ticker: "AAPL", name: "Apple" },
  ]);
  assert.match(sql, /symbol IN \('NVDA', 'AAPL'\)/);
  assert.doesNotMatch(sql, /SPY/);
});

test("chatNewsQuery scopes the Tavily query to chat tickers", () => {
  assert.equal(chatNewsQuery([]), TIMELINE_RAIL_NEWS_QUERY);
  assert.equal(chatNewsQuery(["nvda"]), "NVDA stock news");
  assert.equal(chatNewsQuery(["nvda", "aapl"]), "NVDA AAPL stock news");
});

test("tagsFromChatTickers maps mentions onto the shared tag shape", () => {
  const { tags, watchlist } = tagsFromChatTickers([
    { ticker: "nvda", mention_count: 3, name: "NVIDIA" },
    { ticker: "NVDA", mention_count: 1, name: "dup" },
    { ticker: "aapl", mention_count: 0, name: null },
  ]);
  assert.deepEqual(tags, [
    { ticker: "NVDA", posts: 3 },
    { ticker: "AAPL", posts: 1 },
  ]);
  assert.deepEqual(watchlist, [
    { ticker: "NVDA", name: "NVIDIA" },
    { ticker: "AAPL", name: "AAPL" },
  ]);
});

test("loadTimelineRail composes tags, news, and highlights without failing closed", async () => {
  resetTimelineRailCache();
  const env: TimelineRailEnv = {
    SCHEMA_DB: {
      prepare() {
        return {
          bind() { return this; },
          async all() {
            return { results: [{ ticker: "NVDA", posts: 4 }, { ticker: "SPY", posts: 2 }] };
          },
        };
      },
    } as unknown as D1Database,
    TAVILY_API_KEY: "test-key",
  };
  const lakeSql: string[] = [];
  const rail = await loadTimelineRail({
    env,
    now: Date.UTC(2026, 7, 19),
    queryLake: async (sql) => {
      lakeSql.push(sql);
      if (/futures_quotes/.test(sql)) {
        return [
          { symbol: "VXU26", last: 16.4, prev_close: 17 },
          { symbol: "VXV26", last: 17.1, prev_close: 17 },
        ];
      }
      return [{ symbol: "SPY", spot: 500, prev_close: 490 }];
    },
    fetchImpl: async () =>
      new Response(JSON.stringify({
        results: [{ title: "Breaking tape", url: "https://example.com/n", content: "Indexes jump." }],
      }), { status: 200 }),
  });
  assert.deepEqual(rail.tags, [{ ticker: "NVDA", posts: 4 }, { ticker: "SPY", posts: 2 }]);
  assert.equal(rail.news[0]?.title, "Breaking tape");
  assert.equal(rail.highlights[0]?.ticker, "SPY");
  assert.equal(rail.highlights[0]?.change_1d_pct, (10 / 490) * 100);
  assert.equal(rail.highlights.at(-2)?.ticker, "VXU26");
  assert.equal(rail.highlights.at(-1)?.ticker, "VXV26");
  assert.equal(rail.news_error, undefined);
  assert.equal(rail.highlights_error, undefined);
  assert.equal(lakeSql.some((sql) => /futures_quotes/.test(sql)), true);
});

test("loadTimelineRail degrades news and highlights independently", async () => {
  resetTimelineRailCache();
  const env: TimelineRailEnv = {
    SCHEMA_DB: {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
        };
      },
    } as unknown as D1Database,
  };
  const rail = await loadTimelineRail({
    env,
    now: Date.UTC(2026, 7, 19),
    queryLake: async () => { throw new Error("lake down"); },
    fetchImpl: async () => { throw new Error("should not fetch without a key"); },
  });
  assert.deepEqual(rail.tags, []);
  assert.deepEqual(rail.news, []);
  assert.equal(rail.news_error, "news unavailable");
  assert.deepEqual(rail.highlights, []);
  assert.equal(rail.highlights_error, "lake down");
  assert.equal(TIMELINE_RAIL_NEWS_QUERY.includes("breaking"), true);
});

test("loadChatRail scopes tags, news, and tape to linked tickers", async () => {
  resetTimelineRailCache();
  const env: TimelineRailEnv = {
    SCHEMA_DB: {
      prepare() {
        return {
          bind() { return this; },
          async all() {
            return {
              results: [{
                chat_id: "11111111-1111-4111-8111-111111111111",
                security_id: "sec-nvda",
                ticker: "NVDA",
                first_seen_at: 1,
                last_seen_at: 2,
                mention_count: 2,
                name: "NVIDIA",
                figi: null,
                composite_figi: null,
              }],
            };
          },
        };
      },
    } as unknown as D1Database,
    TAVILY_API_KEY: "test-key",
  };
  let newsQuery = "";
  let lakeCalls = 0;
  const rail = await loadChatRail({
    env,
    now: Date.UTC(2026, 7, 19),
    queryLake: async (sql) => {
      lakeCalls += 1;
      assert.match(sql, /symbol IN \('NVDA'\)/);
      assert.doesNotMatch(sql, /futures_quotes/);
      return [{ symbol: "NVDA", spot: 120, prev_close: 100 }];
    },
    fetchImpl: async (_url, init) => {
      newsQuery = JSON.parse(String(init?.body ?? "{}")).query;
      return new Response(JSON.stringify({
        results: [{ title: "NVDA rallies", url: "https://example.com/nvda", content: "Chips bid." }],
      }), { status: 200 });
    },
  }, "11111111-1111-4111-8111-111111111111");
  assert.equal(rail.chat_id, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(rail.tags, [{ ticker: "NVDA", posts: 2 }]);
  assert.equal(newsQuery, "NVDA stock news");
  assert.equal(rail.news[0]?.title, "NVDA rallies");
  assert.equal(rail.highlights[0]?.ticker, "NVDA");
  assert.equal(rail.highlights[0]?.name, "NVIDIA");
  assert.equal(rail.highlights[0]?.change_1d_pct, 20);
  assert.equal(lakeCalls, 1);
});

test("loadChatRail falls back to market news and tape when no tickers are linked", async () => {
  resetTimelineRailCache();
  const env: TimelineRailEnv = {
    SCHEMA_DB: {
      prepare() {
        return {
          bind() { return this; },
          async all() { return { results: [] }; },
        };
      },
    } as unknown as D1Database,
    TAVILY_API_KEY: "test-key",
  };
  let newsQuery = "";
  const rail = await loadChatRail({
    env,
    now: Date.UTC(2026, 7, 19),
    queryLake: async (sql) => {
      if (/futures_quotes/.test(sql)) {
        return [
          { symbol: "VXU26", last: 16, prev_close: 16 },
          { symbol: "VXV26", last: 17, prev_close: 17 },
        ];
      }
      return [{ symbol: "SPY", spot: 500, prev_close: 490 }];
    },
    fetchImpl: async (_url, init) => {
      newsQuery = JSON.parse(String(init?.body ?? "{}")).query;
      return new Response(JSON.stringify({
        results: [{ title: "Markets open", url: "https://example.com/m", content: "Mixed." }],
      }), { status: 200 });
    },
  }, "22222222-2222-4222-8222-222222222222");
  assert.equal(rail.chat_id, "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(rail.tags, []);
  assert.equal(newsQuery, TIMELINE_RAIL_NEWS_QUERY);
  assert.equal(rail.news[0]?.title, "Markets open");
  assert.equal(rail.highlights[0]?.ticker, "SPY");
  assert.equal(rail.highlights.some((item) => item.ticker === "VXU26"), true);
});
