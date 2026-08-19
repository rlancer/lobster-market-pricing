/**
 * Index + continuous-futures symbols that land in options.ohlc via loader jobs
 * but never appear in options.underlying_snapshots (no CBOE equity option chain
 * pass). Kept in lockstep with loader/symbols/indices.json + futures.json —
 * import the same JSON so typeahead / research identity stay source-of-truth.
 */

import indicesManifest from "../../loader/symbols/indices.json";
import futuresManifest from "../../loader/symbols/futures.json";

export interface CatalogSymbol {
  symbol: string;
  name: string;
  sector: string;
  kind: "index" | "future";
}

type IndexRow = { symbol?: unknown; name?: unknown; family?: unknown };
type FutureRow = { symbol?: unknown; name?: unknown; asset_class?: unknown };

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

function loadCatalog(): CatalogSymbol[] {
  const out: CatalogSymbol[] = [];
  const indices = Array.isArray((indicesManifest as { indices?: unknown }).indices)
    ? ((indicesManifest as { indices: IndexRow[] }).indices)
    : [];
  for (const row of indices) {
    const symbol = str(row.symbol)?.toUpperCase();
    const name = str(row.name);
    if (!symbol || !name) continue;
    out.push({
      symbol,
      name,
      sector: str(row.family) || "Index",
      kind: "index",
    });
  }
  const futures = Array.isArray((futuresManifest as { futures?: unknown }).futures)
    ? ((futuresManifest as { futures: FutureRow[] }).futures)
    : [];
  for (const row of futures) {
    const symbol = str(row.symbol)?.toUpperCase();
    const name = str(row.name);
    if (!symbol || !name) continue;
    out.push({
      symbol,
      name,
      sector: str(row.asset_class) || "Futures",
      kind: "future",
    });
  }
  return out;
}

const CATALOG = loadCatalog();
const BY_SYMBOL = new Map(CATALOG.map((s) => [s.symbol, s]));

export function catalogSymbols(): readonly CatalogSymbol[] {
  return CATALOG;
}

export function catalogLookup(symbol: string): CatalogSymbol | null {
  return BY_SYMBOL.get(symbol.trim().toUpperCase()) ?? null;
}

export type SymbolSuggestion = {
  symbol: string;
  name: string | null;
  sector: string | null;
};

/** Lake underlyings win on collide; catalog fills indexes/futures gaps. */
export function mergeSymbolUniverse(
  lake: SymbolSuggestion[],
  extras: readonly CatalogSymbol[] = CATALOG,
): SymbolSuggestion[] {
  const by = new Map<string, SymbolSuggestion>();
  for (const s of extras) {
    by.set(s.symbol, { symbol: s.symbol, name: s.name, sector: s.sector });
  }
  for (const s of lake) {
    const sym = String(s.symbol || "").toUpperCase();
    if (!sym) continue;
    by.set(sym, {
      symbol: sym,
      name: s.name ?? by.get(sym)?.name ?? null,
      sector: s.sector ?? by.get(sym)?.sector ?? null,
    });
  }
  return [...by.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Same ranking as the historical /api/symbols SQL ORDER BY CASE … */
export function rankSymbolSuggestions(
  items: SymbolSuggestion[],
  q: string | undefined,
  limit: number,
): SymbolSuggestion[] {
  const lim = Math.max(1, Math.min(1000, Math.floor(limit)));
  if (!q) return items.slice(0, lim);
  const needle = q.trim().toUpperCase();
  if (!needle) return items.slice(0, lim);
  const match = items.filter(
    (s) =>
      s.symbol.toUpperCase().includes(needle) ||
      (s.name ?? "").toUpperCase().includes(needle) ||
      (s.sector ?? "").toUpperCase().includes(needle),
  );
  const rank = (s: SymbolSuggestion): number => {
    const sym = s.symbol.toUpperCase();
    if (sym === needle) return 0;
    if (sym.startsWith(needle)) return 1;
    // Prefer ^VIX when the user typed VIX (index cash) over VIXY/VXX substring hits.
    if (sym === `^${needle}`) return 1;
    return 2;
  };
  return match
    .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol))
    .slice(0, lim);
}
