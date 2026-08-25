import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchTavilyNews,
  newsCacheKey,
  parseTavilyNewsResults,
  parseTavilySearchResults,
  railNewsCacheKey,
  readTavilyCache,
  resetTavilyMemoryCache,
  webSearchCacheKey,
  withTavilyCache,
  writeTavilyCache,
} from "../src/tavily.ts";

/** Minimal D1 stand-in that backs tavily_cache read/write. */
function memoryD1() {
  const rows = new Map<string, { payload: string; expires_at: number }>();
  return {
    rows,
    db: {
      prepare(sql: string) {
        const isSelect = /SELECT/i.test(sql);
        let bound: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            bound = args;
            return stmt;
          },
          async first<T>() {
            if (!isSelect) return null;
            const key = String(bound[0] ?? "");
            const row = rows.get(key);
            return (row as T) ?? null;
          },
          async run() {
            const key = String(bound[0] ?? "");
            const payload = String(bound[1] ?? "");
            const expires_at = Number(bound[2] ?? 0);
            rows.set(key, { payload, expires_at });
            return { success: true };
          },
        };
        return stmt;
      },
    } as unknown as D1Database,
  };
}

test("cache key helpers normalize symbol and query", () => {
  assert.equal(newsCacheKey(" aapl "), "news:AAPL");
  assert.equal(webSearchCacheKey(" What Happened? "), "websearch:what happened?");
  assert.equal(railNewsCacheKey("Breaking"), "rail:breaking");
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

test("parseTavilySearchResults strips empty titles and links", () => {
  const items = parseTavilySearchResults({
    results: [
      { title: "Note", url: "https://example.com/n", content: "Analyst take.", source: "Reuters" },
      { title: "Missing url", content: "Nope" },
    ],
  }, 5);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.source, "Reuters");
});

test("withTavilyCache stores successes in D1 and serves them without refetch", async () => {
  resetTavilyMemoryCache();
  const { db, rows } = memoryD1();
  const now = Date.UTC(2026, 7, 25, 12);
  let fetches = 0;
  const compute = async () => {
    fetches += 1;
    return [{ title: "AAPL jumps", link: "https://example.com/a", published: null, snippet: "Up.", source: "tavily" as const }];
  };

  const first = await withTavilyCache(db, newsCacheKey("AAPL"), 10 * 60 * 1000, compute, { now });
  assert.equal(first.length, 1);
  assert.equal(fetches, 1);
  assert.equal(rows.has("news:AAPL"), true);

  resetTavilyMemoryCache();
  const second = await withTavilyCache(db, newsCacheKey("AAPL"), 10 * 60 * 1000, compute, { now: now + 60_000 });
  assert.equal(second[0]?.title, "AAPL jumps");
  assert.equal(fetches, 1, "D1 hit must skip Tavily");
});

test("withTavilyCache ignores expired D1 rows", async () => {
  resetTavilyMemoryCache();
  const { db } = memoryD1();
  const now = Date.UTC(2026, 7, 25, 12);
  await writeTavilyCache(db, newsCacheKey("MSFT"), [{ title: "stale" }], now - 1);
  let fetches = 0;
  const fresh = await withTavilyCache(
    db,
    newsCacheKey("MSFT"),
    10 * 60 * 1000,
    async () => {
      fetches += 1;
      return [{ title: "fresh", link: "https://example.com/m", published: null, snippet: "", source: "tavily" as const }];
    },
    { now },
  );
  assert.equal(fetches, 1);
  assert.equal(fresh[0]?.title, "fresh");
});

test("readTavilyCache soft-fails when D1 is broken", async () => {
  const broken = {
    prepare() {
      throw new Error("d1 down");
    },
  } as unknown as D1Database;
  assert.equal(await readTavilyCache(broken, "news:AAPL"), null);
});

test("fetchTavilyNews posts news-topic body and maps results", async () => {
  let body: Record<string, unknown> | null = null;
  const items = await fetchTavilyNews({
    apiKey: "k",
    query: "NVDA stock news",
    maxResults: 6,
    days: 2,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({
        results: [{ title: "Chips", url: "https://example.com/c", content: "Bid." }],
      }), { status: 200 });
    },
  });
  assert.equal(body?.topic, "news");
  assert.equal(body?.days, 2);
  assert.equal(items[0]?.title, "Chips");
});

test("withTavilyCache does not persist thrown failures", async () => {
  resetTavilyMemoryCache();
  const { db, rows } = memoryD1();
  await assert.rejects(
    () => withTavilyCache(db, webSearchCacheKey("boom"), 60_000, async () => {
      throw new Error("tavily returned HTTP 429");
    }),
    /HTTP 429/,
  );
  assert.equal(rows.size, 0);
});
