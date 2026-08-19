import assert from "node:assert/strict";
import test from "node:test";
import {
  highlightsFromOhlcRows,
  loadTimelineRail,
  marketHighlightSql,
  parseTavilyNewsResults,
  pctChange,
  rankTimelineTags,
  resetTimelineRailCache,
  TIMELINE_RAIL_NEWS_QUERY,
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
    { symbol: "^VIX", spot: 16, prev_close: 20 },
  ]);
  assert.equal(items[0]?.ticker, "SPY");
  assert.equal(items[0]?.spot, 510);
  assert.equal(items[0]?.change_1d_pct, 2);
  assert.equal(items[1]?.ticker, "QQQ");
  assert.equal(items[1]?.change_1d_pct, 10);
  assert.equal(items[2]?.ticker, "IWM");
  assert.equal(items[2]?.spot, null);
  assert.equal(items[4]?.ticker, "^VIX");
  assert.equal(items[4]?.change_1d_pct, -20);
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
  assert.match(sql, /symbol IN \('SPY', 'QQQ', 'IWM', 'DIA', '\^VIX'\)/);
  assert.match(sql, /date >= '2026-08-05'/);
  assert.match(sql, /FROM options\.ohlc/);
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
  const rail = await loadTimelineRail({
    env,
    now: Date.UTC(2026, 7, 19),
    queryLake: async () => [
      { symbol: "SPY", spot: 500, prev_close: 490 },
    ],
    fetchImpl: async () =>
      new Response(JSON.stringify({
        results: [{ title: "Breaking tape", url: "https://example.com/n", content: "Indexes jump." }],
      }), { status: 200 }),
  });
  assert.deepEqual(rail.tags, [{ ticker: "NVDA", posts: 4 }, { ticker: "SPY", posts: 2 }]);
  assert.equal(rail.news[0]?.title, "Breaking tape");
  assert.equal(rail.highlights[0]?.ticker, "SPY");
  assert.equal(rail.highlights[0]?.change_1d_pct, (10 / 490) * 100);
  assert.equal(rail.news_error, undefined);
  assert.equal(rail.highlights_error, undefined);
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
