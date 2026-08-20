/**
 * Desktop companion rail shared by the home timeline and /chat: tags,
 * headlines, and a tape. Timeline scopes tags to public posts and the tape
 * to the index watchlist; chat scopes all three to tickers linked on that
 * conversation. Failures degrade per-section so the page still loads;
 * never 500 on a Tavily or lake outage.
 */
import { listChatTickers } from "./chat-tickers";

export const TIMELINE_RAIL_TAGS_LIMIT = 16;
export const TIMELINE_RAIL_NEWS_LIMIT = 6;
export const TIMELINE_RAIL_NEWS_TTL_MS = 10 * 60 * 1000;
export const TIMELINE_RAIL_NEWS_DAYS = 2;
export const TIMELINE_RAIL_NEWS_QUERY = "US stock market breaking news";
/** Cap how many chat-linked tickers drive news + tape. */
export const CHAT_RAIL_TICKER_LIMIT = 8;
const TAVILY_API_URL = "https://api.tavily.com/search";
const NEWS_SNIPPET_MAX = 240;
/** Calendar window wide enough for two sessions around a long weekend. */
const HIGHLIGHT_LOOKBACK_DAYS = 14;

export const MARKET_HIGHLIGHT_WATCHLIST: ReadonlyArray<{ ticker: string; name: string }> = [
  { ticker: "SPY", name: "S&P 500" },
  { ticker: "QQQ", name: "Nasdaq-100" },
  { ticker: "IWM", name: "Russell 2000" },
  { ticker: "DIA", name: "Dow Jones" },
  { ticker: "^VIX", name: "VIX" },
];

export interface TimelineRailTag {
  ticker: string;
  posts: number;
}

export interface TimelineRailNewsItem {
  title: string;
  link: string;
  published: string | null;
  snippet: string;
  source: "tavily";
}

export interface TimelineRailHighlight {
  ticker: string;
  name: string;
  spot: number | null;
  change_1d_pct: number | null;
}

export interface TimelineRail {
  tags: TimelineRailTag[];
  news: TimelineRailNewsItem[];
  highlights: TimelineRailHighlight[];
  news_error?: string;
  highlights_error?: string;
  fetched_at: string;
}

export type TimelineLakeQuery = (sql: string, key: string) => Promise<Record<string, unknown>[]>;

export interface TimelineRailEnv {
  SCHEMA_DB: D1Database;
  TAVILY_API_KEY?: string;
}

export interface TimelineRailDeps {
  env: TimelineRailEnv;
  queryLake?: TimelineLakeQuery;
  now?: number;
  fetchImpl?: typeof fetch;
}

interface CacheEntry<T> { ts: number; val: T; }
const newsCache = new Map<string, CacheEntry<TimelineRailNewsItem[]>>();

/** Test hook — isolate-level news memo must not leak across cases. */
export function resetTimelineRailCache(): void {
  newsCache.clear();
}

export function pctChange(from: number | null, to: number | null): number | null {
  if (from == null || to == null || from === 0) return null;
  return ((to - from) / from) * 100;
}

export function rankTimelineTags(
  rows: { ticker: string | null; posts: number | null }[],
  limit = TIMELINE_RAIL_TAGS_LIMIT,
): TimelineRailTag[] {
  const ranked = rows
    .map((row) => ({
      ticker: (row.ticker ?? "").trim().toUpperCase(),
      posts: Number(row.posts) || 0,
    }))
    .filter((row) => row.ticker && row.posts > 0)
    .sort((a, b) => b.posts - a.posts || (a.ticker < b.ticker ? -1 : 1));
  return ranked.slice(0, Math.max(1, Math.min(40, limit)));
}

export function highlightsFromOhlcRows(
  rows: Record<string, unknown>[],
  watchlist: ReadonlyArray<{ ticker: string; name: string }> = MARKET_HIGHLIGHT_WATCHLIST,
): TimelineRailHighlight[] {
  const byTicker = new Map<string, { spot: number | null; prev: number | null }>();
  for (const row of rows) {
    const ticker = String(row.symbol ?? row.ticker ?? "").trim().toUpperCase();
    if (!ticker) continue;
    const spot = numOrNull(row.spot ?? row.close);
    const prev = numOrNull(row.prev_close);
    byTicker.set(ticker, { spot, prev });
  }
  return watchlist.map((item) => {
    const row = byTicker.get(item.ticker.toUpperCase());
    return {
      ticker: item.ticker,
      name: item.name,
      spot: row?.spot ?? null,
      change_1d_pct: pctChange(row?.prev ?? null, row?.spot ?? null),
    };
  });
}

export function parseTavilyNewsResults(
  data: { results?: { title?: string; url?: string; content?: string; published_date?: string | null }[] },
  limit = TIMELINE_RAIL_NEWS_LIMIT,
): TimelineRailNewsItem[] {
  return (data.results ?? [])
    .map((row): TimelineRailNewsItem => ({
      title: (row.title ?? "").trim(),
      link: (row.url ?? "").trim(),
      published: row.published_date || null,
      snippet: truncateAtSentence((row.content ?? "").trim()),
      source: "tavily",
    }))
    .filter((item) => item.title && item.link)
    .slice(0, Math.max(1, Math.min(20, limit)));
}

export function marketHighlightSql(
  since: string,
  watchlist: ReadonlyArray<{ ticker: string; name: string }> = MARKET_HIGHLIGHT_WATCHLIST,
): string {
  const symbols = watchlist.map((item) => lit(item.ticker)).join(", ");
  return (
    "WITH latest_bars AS (\n" +
    "  SELECT symbol, date, close,\n" +
    "    ROW_NUMBER() OVER (PARTITION BY symbol, date ORDER BY fetched_at DESC, run_id DESC) AS drn\n" +
    "  FROM options.ohlc\n" +
    `  WHERE symbol IN (${symbols})\n` +
    `    AND date >= ${lit(since)}\n` +
    "    AND close IS NOT NULL\n" +
    "), deduped AS (\n" +
    "  SELECT symbol, date, close FROM latest_bars WHERE drn = 1\n" +
    "), ranked AS (\n" +
    "  SELECT symbol, date, close,\n" +
    "    ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn\n" +
    "  FROM deduped\n" +
    ")\n" +
    "SELECT a.symbol, a.close AS spot, b.close AS prev_close, a.date\n" +
    "FROM ranked a\n" +
    "LEFT JOIN ranked b ON a.symbol = b.symbol AND b.rn = 2\n" +
    "WHERE a.rn = 1"
  );
}

/** Build a Tavily news query from chat-linked tickers (capped). */
export function chatNewsQuery(tickers: string[]): string {
  const clean = tickers
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, CHAT_RAIL_TICKER_LIMIT);
  if (clean.length === 0) return TIMELINE_RAIL_NEWS_QUERY;
  if (clean.length === 1) return `${clean[0]} stock news`;
  return `${clean.join(" ")} stock news`;
}

/** Map chat_tickers rows onto the shared rail tag shape (posts = mentions). */
export function tagsFromChatTickers(
  links: { ticker: string; mention_count: number; name?: string | null }[],
  limit = CHAT_RAIL_TICKER_LIMIT,
): { tags: TimelineRailTag[]; watchlist: { ticker: string; name: string }[] } {
  const tags: TimelineRailTag[] = [];
  const watchlist: { ticker: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const ticker = link.ticker.trim().toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    tags.push({ ticker, posts: Math.max(1, Number(link.mention_count) || 1) });
    watchlist.push({
      ticker,
      name: (link.name ?? "").trim() || ticker,
    });
    if (tags.length >= limit) break;
  }
  return { tags, watchlist };
}

export async function loadTimelineRail(deps: TimelineRailDeps): Promise<TimelineRail> {
  const now = deps.now ?? Date.now();
  const fetched_at = new Date(now).toISOString();
  const [tags, newsResult, highlightsResult] = await Promise.all([
    loadTags(deps.env.SCHEMA_DB, now).catch(() => [] as TimelineRailTag[]),
    loadNews(deps, TIMELINE_RAIL_NEWS_QUERY, "breaking").catch(
      (error): { items: TimelineRailNewsItem[]; error?: string } => ({
        items: [],
        error: String((error && (error as Error).message) || error),
      }),
    ),
    loadHighlights(deps, now).catch((error): { items: TimelineRailHighlight[]; error?: string } => ({
      items: [],
      error: String((error && (error as Error).message) || error),
    })),
  ]);

  const rail: TimelineRail = {
    tags,
    news: newsResult.items,
    highlights: highlightsResult.items,
    fetched_at,
  };
  if (newsResult.error) rail.news_error = newsResult.error;
  if (highlightsResult.error) rail.highlights_error = highlightsResult.error;
  return rail;
}

/**
 * Chat-scoped rail. When the conversation has linked tickers, tags / news /
 * tape follow those symbols; otherwise fall back to the market timeline rail
 * so a fresh chat still has useful context.
 */
export async function loadChatRail(
  deps: TimelineRailDeps,
  chatId: string,
): Promise<TimelineRail & { chat_id: string }> {
  const links = await listChatTickers(deps.env.SCHEMA_DB, chatId).catch(() => []);
  const { tags, watchlist } = tagsFromChatTickers(links);
  if (watchlist.length === 0) {
    const market = await loadTimelineRail(deps);
    return { ...market, chat_id: chatId, tags: [] };
  }

  const now = deps.now ?? Date.now();
  const fetched_at = new Date(now).toISOString();
  const newsQuery = chatNewsQuery(watchlist.map((item) => item.ticker));
  const cacheKey = `chat:${watchlist.map((item) => item.ticker).join(",")}`;
  const [newsResult, highlightsResult] = await Promise.all([
    loadNews(deps, newsQuery, cacheKey).catch(
      (error): { items: TimelineRailNewsItem[]; error?: string } => ({
        items: [],
        error: String((error && (error as Error).message) || error),
      }),
    ),
    loadHighlights(deps, now, watchlist).catch(
      (error): { items: TimelineRailHighlight[]; error?: string } => ({
        items: [],
        error: String((error && (error as Error).message) || error),
      }),
    ),
  ]);

  const rail: TimelineRail & { chat_id: string } = {
    chat_id: chatId,
    tags,
    news: newsResult.items,
    highlights: highlightsResult.items,
    fetched_at,
  };
  if (newsResult.error) rail.news_error = newsResult.error;
  if (highlightsResult.error) rail.highlights_error = highlightsResult.error;
  return rail;
}

async function loadTags(db: D1Database, now: number): Promise<TimelineRailTag[]> {
  const rows = await db.prepare(
    `SELECT UPPER(TRIM(ct.ticker)) AS ticker, COUNT(DISTINCT s.share_id) AS posts
     FROM chat_tickers ct
     JOIN shared_chats s ON s.chat_id = ct.chat_id
     WHERE (s.expires_at IS NULL OR s.expires_at > ?1)
       AND TRIM(ct.ticker) != ''
       AND (
         EXISTS (SELECT 1 FROM timeline_posts p WHERE p.share_id = s.share_id)
         OR (
           s.bot_handle IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM bot_profiles b
             WHERE b.handle = s.bot_handle AND b.enabled = 1
           )
         )
       )
     GROUP BY UPPER(TRIM(ct.ticker))
     ORDER BY posts DESC, ticker ASC
     LIMIT ?2`,
  ).bind(now, TIMELINE_RAIL_TAGS_LIMIT).all<{ ticker: string; posts: number }>();
  return rankTimelineTags(rows.results ?? []);
}

async function loadNews(
  deps: TimelineRailDeps,
  query: string,
  cacheKey: string,
): Promise<{ items: TimelineRailNewsItem[]; error?: string }> {
  const key = deps.env.TAVILY_API_KEY?.trim();
  if (!key) return { items: [], error: "news unavailable" };
  const hit = newsCache.get(cacheKey);
  const now = deps.now ?? Date.now();
  if (hit && now - hit.ts < TIMELINE_RAIL_NEWS_TTL_MS) {
    return { items: hit.val };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(TAVILY_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      query,
      topic: "news",
      search_depth: "basic",
      max_results: TIMELINE_RAIL_NEWS_LIMIT,
      days: TIMELINE_RAIL_NEWS_DAYS,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!response.ok) {
    return { items: [], error: `tavily news returned HTTP ${response.status}` };
  }
  const data = await response.json() as {
    results?: { title?: string; url?: string; content?: string; published_date?: string | null }[];
  };
  const items = parseTavilyNewsResults(data);
  newsCache.set(cacheKey, { ts: now, val: items });
  return { items };
}

async function loadHighlights(
  deps: TimelineRailDeps,
  now: number,
  watchlist: ReadonlyArray<{ ticker: string; name: string }> = MARKET_HIGHLIGHT_WATCHLIST,
): Promise<{ items: TimelineRailHighlight[]; error?: string }> {
  if (!deps.queryLake) return { items: [], error: "lake unavailable" };
  if (watchlist.length === 0) return { items: [], error: "no symbols" };
  const since = new Date(now - HIGHLIGHT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const cacheKey = watchlist === MARKET_HIGHLIGHT_WATCHLIST
    ? "timeline_rail_hl_v1"
    : `chat_rail_hl_v1_${watchlist.map((item) => item.ticker).join("_")}`;
  const rows = await deps.queryLake(marketHighlightSql(since, watchlist), cacheKey);
  const items = highlightsFromOhlcRows(rows, watchlist);
  const missing = items.every((item) => item.spot == null);
  if (missing && rows.length === 0) return { items, error: "no highlight bars" };
  return { items };
}

function truncateAtSentence(s: string, max = NEWS_SNIPPET_MAX): string {
  if (s.length <= max) return s;
  const window = s.slice(0, max + 1);
  const boundary = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  return (boundary >= max * 0.6 ? window.slice(0, boundary + 1) : window).trimEnd();
}

function lit(v: unknown): string {
  if (v == null) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? null : n;
}
