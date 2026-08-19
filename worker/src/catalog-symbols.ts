/**
 * Index + continuous-futures symbols that land in options.ohlc via loader jobs
 * but never appear in options.underlying_snapshots (no CBOE equity option chain
 * pass). Kept in lockstep with loader/symbols/indices.json + futures.json —
 * import the same JSON so typeahead / research identity stay source-of-truth.
 *
 * Thinkorswim-style `/ROOT` search (e.g. `/ES`, `/VX`) resolves to the
 * researchable lake symbol (`ES=F`, `^VIX`).
 */

import indicesManifest from "../../loader/symbols/indices.json";
import futuresManifest from "../../loader/symbols/futures.json";

export interface CatalogSymbol {
  symbol: string;
  name: string;
  sector: string;
  kind: "index" | "future";
  /** Futures root without slash — `ES` for `ES=F`, `VX` for cash VIX alias. */
  slash_root?: string;
}

type IndexRow = { symbol?: unknown; name?: unknown; family?: unknown };
type FutureRow = { symbol?: unknown; name?: unknown; asset_class?: unknown };

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

/**
 * CFE / platform roots that are not Yahoo `=F` continuous contracts but still
 * belong in `/ROOT` typeahead. Target is the best researchable lake symbol.
 */
const CFE_SLASH_ALIASES: ReadonlyArray<{ root: string; symbol: string; name: string; sector: string }> = [
  { root: "VX", symbol: "^VIX", name: "CBOE Volatility Index", sector: "VIX" },
  { root: "VIX", symbol: "^VIX", name: "CBOE Volatility Index", sector: "VIX" },
  { root: "VXM", symbol: "VIXM", name: "ProShares VIX Mid-Term Futures ETF", sector: "Volatility" },
];

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
      slash_root: symbol === "^VIX" ? "VX" : undefined,
    });
  }
  const futures = Array.isArray((futuresManifest as { futures?: unknown }).futures)
    ? ((futuresManifest as { futures: FutureRow[] }).futures)
    : [];
  for (const row of futures) {
    const symbol = str(row.symbol)?.toUpperCase();
    const name = str(row.name);
    if (!symbol || !name) continue;
    const root = continuousFuturesRoot(symbol);
    out.push({
      symbol,
      name: root ? `${name} (/${root})` : name,
      sector: str(row.asset_class) || "Futures",
      kind: "future",
      slash_root: root ?? undefined,
    });
  }
  return out;
}

/** `ES=F` → `ES`; non-continuous symbols → null. */
export function continuousFuturesRoot(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}=F$/.test(s)) return null;
  return s.slice(0, -2);
}

const CATALOG = loadCatalog();
const BY_SYMBOL = new Map(CATALOG.map((s) => [s.symbol, s]));

/** `/ES` → `ES=F`, `/VX` → `^VIX`. */
const SLASH_ROOT_TO_SYMBOL = new Map<string, string>();
for (const s of CATALOG) {
  if (s.slash_root) SLASH_ROOT_TO_SYMBOL.set(s.slash_root, s.symbol);
}
for (const alias of CFE_SLASH_ALIASES) {
  if (!SLASH_ROOT_TO_SYMBOL.has(alias.root)) {
    SLASH_ROOT_TO_SYMBOL.set(alias.root, alias.symbol.toUpperCase());
  }
}

export function catalogSymbols(): readonly CatalogSymbol[] {
  return CATALOG;
}

export function catalogLookup(symbol: string): CatalogSymbol | null {
  const key = symbol.trim().toUpperCase();
  const direct = BY_SYMBOL.get(key);
  if (direct) return direct;
  const fromSlash = resolveSlashRoot(key);
  return fromSlash ? BY_SYMBOL.get(fromSlash) ?? null : null;
}

/** Strip a leading `/` and return the futures root, or null if not slash form. */
export function slashRootFromQuery(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  if (!t.startsWith("/")) return null;
  const root = t.slice(1).trim();
  if (!root) return "";
  if (!/^[A-Z0-9]{1,6}$/.test(root)) return null;
  return root;
}

/**
 * Map `/ES` or `ES` (when unambiguously a futures root query context) to the
 * lake symbol. Returns null when the root is unknown.
 */
export function resolveSlashRoot(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  const root = t.startsWith("/") ? slashRootFromQuery(t) : null;
  if (root === null) return null;
  if (root === "") return null;
  return SLASH_ROOT_TO_SYMBOL.get(root) ?? null;
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
  // Ensure CFE slash alias targets exist even when not in the index/futures JSON
  // (e.g. VIXM may already be in the lake; ^VIX is in indices).
  for (const alias of CFE_SLASH_ALIASES) {
    const sym = alias.symbol.toUpperCase();
    if (!by.has(sym)) {
      by.set(sym, { symbol: sym, name: `${alias.name} (/${alias.root})`, sector: alias.sector });
    } else {
      const cur = by.get(sym)!;
      // Surface the /ROOT hint on ^VIX so /vx search results read clearly.
      if (sym === "^VIX" && cur.name && !cur.name.includes("/VX")) {
        by.set(sym, { ...cur, name: `${cur.name} (/VX)` });
      }
    }
  }
  for (const s of lake) {
    const sym = String(s.symbol || "").toUpperCase();
    if (!sym) continue;
    const prev = by.get(sym);
    by.set(sym, {
      symbol: sym,
      name: s.name ?? prev?.name ?? null,
      sector: s.sector ?? prev?.sector ?? null,
    });
  }
  return [...by.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function suggestionFuturesRoot(symbol: string): string | null {
  return continuousFuturesRoot(symbol) ?? (symbol === "^VIX" ? "VX" : null);
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

  const slashRoot = slashRootFromQuery(needle);
  if (slashRoot !== null) {
    // `/` or `/ES` — futures-root mode (no equity substring noise like CVX for /VX).
    const match = items.filter((s) => {
      const sym = s.symbol.toUpperCase();
      const root = suggestionFuturesRoot(sym);
      if (!slashRoot) return root != null; // bare `/` → all futures /VX-aliased
      if (root === slashRoot) return true;
      if (root && root.startsWith(slashRoot)) return true;
      if (resolveSlashRoot(`/${slashRoot}`) === sym) return true;
      return false;
    });
    const rank = (s: SymbolSuggestion): number => {
      const sym = s.symbol.toUpperCase();
      const root = suggestionFuturesRoot(sym);
      const resolved = slashRoot ? resolveSlashRoot(`/${slashRoot}`) : null;
      if (resolved && sym === resolved) return 0;
      if (root === slashRoot) return 0;
      if (root && slashRoot && root.startsWith(slashRoot)) return 1;
      return 2;
    };
    return match
      .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol))
      .slice(0, lim);
  }

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
    // Prefer ES=F when the user typed the futures root ES.
    if (continuousFuturesRoot(sym) === needle) return 1;
    return 2;
  };
  return match
    .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol))
    .slice(0, lim);
}
