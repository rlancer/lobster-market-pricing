/**
 * Tavily search proxy helpers + durable D1 cache.
 *
 * News (`topic: news`) and open web search share one API key and the same
 * strip-to-citable-links shape. Successes are memoized in-isolate (L1) and
 * in D1 `tavily_cache` (L2) so cold isolates / cross-user repeats do not
 * re-spend the monthly credit pool. Failures are never cached.
 */

export const TAVILY_API_URL = "https://api.tavily.com/search";
/** Recency window for news-topic searches (days). */
export const TAVILY_NEWS_DAYS = 7;
export const TAVILY_DEFAULT_TTL_MS = 10 * 60 * 1000;
const SNIPPET_MAX = 240;

export interface TavilyNewsItem {
  title: string;
  link: string;
  published: string | null;
  snippet: string;
  source: "tavily";
}

export interface TavilySearchResult {
  title: string;
  link: string;
  snippet: string;
  source: string | null;
}

export interface TavilyEnv {
  SCHEMA_DB: D1Database;
  TAVILY_API_KEY?: string;
}

interface CacheEntry<T> { ts: number; val: T; }
const memory = new Map<string, CacheEntry<unknown>>();

/** Test hook — isolate memo must not leak across cases. */
export function resetTavilyMemoryCache(): void {
  memory.clear();
}

export function truncateAtSentence(s: string, max = SNIPPET_MAX): string {
  if (s.length <= max) return s;
  const window = s.slice(0, max + 1);
  const boundary = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  return (boundary >= max * 0.6 ? window.slice(0, boundary + 1) : window).trimEnd();
}

export function newsCacheKey(symbol: string): string {
  return `news:${symbol.trim().toUpperCase()}`;
}

export function webSearchCacheKey(query: string): string {
  return `websearch:${query.trim().toLowerCase()}`;
}

export function railNewsCacheKey(scope: string): string {
  return `rail:${scope.trim().toLowerCase()}`;
}

export function parseTavilyNewsResults(
  data: { results?: { title?: string; url?: string; content?: string; published_date?: string | null }[] },
  limit: number,
): TavilyNewsItem[] {
  return (data.results ?? [])
    .map((row): TavilyNewsItem => ({
      title: (row.title ?? "").trim(),
      link: (row.url ?? "").trim(),
      published: row.published_date || null,
      snippet: truncateAtSentence((row.content ?? "").trim()),
      source: "tavily",
    }))
    .filter((item) => item.title && item.link)
    .slice(0, Math.max(1, Math.min(40, limit)));
}

export function parseTavilySearchResults(
  data: { results?: { title?: string; url?: string; content?: string; source?: string | null }[] },
  limit: number,
): TavilySearchResult[] {
  return (data.results ?? [])
    .map((row): TavilySearchResult => ({
      title: (row.title ?? "").trim(),
      link: (row.url ?? "").trim(),
      snippet: truncateAtSentence((row.content ?? "").trim()),
      source: (row.source ?? "").trim() || null,
    }))
    .filter((item) => item.title && item.link)
    .slice(0, Math.max(1, Math.min(20, limit)));
}

export async function readTavilyCache<T>(
  db: D1Database,
  key: string,
  now = Date.now(),
): Promise<T | null> {
  try {
    const row = await db.prepare(
      "SELECT payload, expires_at FROM tavily_cache WHERE key = ?1",
    ).bind(key).first<{ payload: string; expires_at: number }>();
    if (!row || row.expires_at <= now) return null;
    return JSON.parse(row.payload) as T;
  } catch (e) {
    console.error("tavily cache read failed", e);
    return null;
  }
}

export async function writeTavilyCache(
  db: D1Database,
  key: string,
  payload: unknown,
  expiresAt: number,
): Promise<void> {
  try {
    await db.prepare(
      "INSERT INTO tavily_cache (key, payload, expires_at) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at",
    ).bind(key, JSON.stringify(payload), expiresAt).run();
  } catch (e) {
    console.error("tavily cache write failed", e);
  }
}

/**
 * L1 (isolate Map) → L2 (D1) → compute. Only successful compute results are
 * stored. D1 outages never block a live Tavily call.
 */
export async function withTavilyCache<T>(
  db: D1Database | undefined,
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
  opts?: { now?: number },
): Promise<T> {
  const now = opts?.now ?? Date.now();
  const mem = memory.get(key);
  if (mem && now - mem.ts < ttlMs) return mem.val as T;

  if (db) {
    const durable = await readTavilyCache<T>(db, key, now);
    if (durable != null) {
      memory.set(key, { ts: now, val: durable });
      return durable;
    }
  }

  const val = await compute();
  memory.set(key, { ts: now, val });
  if (db) await writeTavilyCache(db, key, val, now + ttlMs);
  return val;
}

export interface TavilyFetchOpts {
  apiKey: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

export async function tavilyFetchJson(
  opts: TavilyFetchOpts,
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(TAVILY_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(opts.body),
  });
  if (!response.ok) throw new Error(`tavily returned HTTP ${response.status}`);
  return response.json();
}

export async function fetchTavilyNews(
  opts: {
    apiKey: string;
    query: string;
    maxResults: number;
    days?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<TavilyNewsItem[]> {
  const data = await tavilyFetchJson({
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
    body: {
      query: opts.query,
      topic: "news",
      search_depth: "basic",
      max_results: opts.maxResults,
      days: opts.days ?? TAVILY_NEWS_DAYS,
      include_answer: false,
      include_raw_content: false,
    },
  }) as { results?: { title?: string; url?: string; content?: string; published_date?: string | null }[] };
  return parseTavilyNewsResults(data, opts.maxResults);
}

export async function fetchTavilySearch(
  opts: {
    apiKey: string;
    query: string;
    maxResults: number;
    fetchImpl?: typeof fetch;
  },
): Promise<TavilySearchResult[]> {
  const data = await tavilyFetchJson({
    apiKey: opts.apiKey,
    fetchImpl: opts.fetchImpl,
    body: {
      query: opts.query,
      include_answer: false,
      include_raw_content: false,
      search_depth: "basic",
      max_results: opts.maxResults,
    },
  }) as { results?: { title?: string; url?: string; content?: string; source?: string | null }[] };
  return parseTavilySearchResults(data, opts.maxResults);
}
