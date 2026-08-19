// Cross-session symbol search cache.
//
// The ticker typeahead fires on every keystroke; the universe (~500 symbols,
// symbols/names/sectors) changes at most nightly (loader refresh),
// so it is cached in localStorage for 24h and filtered client-side — a browser
// restart or a fresh tab performs zero lake queries for search until the cache
// ages out. Falls back to the server-side /api/symbols search whenever the
// cache is unavailable (blocked storage, corrupt payload, network fetch failed).

import { api, type SymbolSuggestion } from './api';

const STORAGE_KEY = 'symbol_cache_v2';
/** Universe refreshes nightly; 24h bounds staleness to at most one day. */
const SYMBOL_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_LIMIT = 50;

interface SymbolCacheEntry {
  ts: number;
  items: SymbolSuggestion[];
}

function readCache(): SymbolCacheEntry | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as SymbolCacheEntry;
  if (!Array.isArray(parsed.items)) return null;
  return parsed;
}

function writeCache(items: SymbolSuggestion[]): void {
  const entry: SymbolCacheEntry = { ts: Date.now(), items };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
}

/** The full symbol universe from localStorage when fresh, else a server fetch. */
export async function cachedSymbols(): Promise<SymbolSuggestion[]> {
  try {
    const cached = readCache();
    if (cached && Date.now() - cached.ts < SYMBOL_TTL_MS) return cached.items;
  } catch {
    // Blocked/corrupt storage — nothing cached; fall through to the server.
  }
  const items = await api.symbolsAll();
  try {
    writeCache(items);
  } catch {
    // Quota/private mode — serve this session without persisting.
  }
  return items;
}

/**
 * Rank a needle against the universe, mirroring the worker's ordering:
 * exact symbol match, then symbol-prefix, then any substring (symbol or name),
 * ties broken by symbol. Pure and synchronous for testing.
 */
export function rankSymbols(
  items: SymbolSuggestion[],
  needle: string,
): SymbolSuggestion[] {
  if (!needle) return items.slice(0, SEARCH_LIMIT);
  const q = needle.toUpperCase();
  const match = items.filter(
    (s) =>
      s.symbol.toUpperCase().includes(q) ||
      (s.name ?? '').toUpperCase().includes(q),
  );
  const rank = (s: SymbolSuggestion): number => {
    const sym = s.symbol.toUpperCase();
    if (sym === q) return 0;
    if (sym.startsWith(q)) return 1;
    // Prefer ^VIX when the user typed VIX (cash index) over VIXY/VXX.
    if (sym === `^${q}`) return 1;
    return 2;
  };
  return match
    .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol))
    .slice(0, SEARCH_LIMIT);
}

/**
 * Search the cached universe client-side; falls back to the server-side
 * /api/symbols search when the universe is unavailable.
 */
export async function searchSymbols(q: string): Promise<SymbolSuggestion[]> {
  const needle = q.trim();
  try {
    const universe = await cachedSymbols();
    return rankSymbols(universe, needle);
  } catch {
    return api.symbols(needle);
  }
}
