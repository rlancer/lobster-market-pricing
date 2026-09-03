/**
 * Identify what a ticker actually is (equity vs ETF vs index vs …).
 *
 * Lake coverage is incomplete — RSP, VGSH, and other funds are often absent
 * from options.etf_profiles / instruments. Yahoo's search endpoint still
 * returns quoteType + name without a crumb session, which is enough to stop
 * the desk from treating a diversified ETF as a single-name stock.
 */

import { catalogLookup } from "./catalog-symbols";
import { YAHOO_UA } from "./yahoo-intraday";

export const LOOKUP_SYMBOLS_MAX = 20;
export const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
export const YAHOO_SEARCH_TIMEOUT_MS = 8_000;

export const SYMBOL_KINDS = [
  "equity",
  "etf",
  "fund",
  "index",
  "future",
  "crypto",
  "option",
  "bond",
  "cash",
  "fx",
  "unknown",
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export const IDENTITY_SOURCES = ["catalog", "yahoo", "schwab", "none"] as const;
export type IdentitySource = (typeof IDENTITY_SOURCES)[number];

export interface SymbolIdentity {
  symbol: string;
  name: string | null;
  kind: SymbolKind;
  source: IdentitySource;
}

const KIND_SET = new Set<string>(SYMBOL_KINDS);

export function isSymbolKind(value: unknown): value is SymbolKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/** Map Schwab Trader / Market Data assetType (or assetMainType) to a kind. */
export function kindFromSchwabAssetType(assetType: string | null | undefined): SymbolKind {
  const raw = (assetType ?? "").trim().toUpperCase();
  if (!raw) return "unknown";
  switch (raw) {
    case "EQUITY":
      return "equity";
    case "COLLECTIVE_INVESTMENT":
    case "ETF":
      return "etf";
    case "MUTUAL_FUND":
    case "MUTUALFUND":
      return "fund";
    case "INDEX":
      return "index";
    case "OPTION":
      return "option";
    case "FUTURE":
    case "FUTURES":
      return "future";
    case "FIXED_INCOME":
    case "BOND":
      return "bond";
    case "CASH_EQUIVALENT":
    case "CASH":
      return "cash";
    case "CURRENCY":
    case "FOREX":
      return "fx";
    case "CRYPTOCURRENCY":
    case "CRYPTO":
      return "crypto";
    default:
      return "unknown";
  }
}

/** Map Yahoo finance search / quote `quoteType` to a kind. */
export function kindFromYahooQuoteType(quoteType: string | null | undefined): SymbolKind {
  const raw = (quoteType ?? "").trim().toUpperCase();
  if (!raw) return "unknown";
  switch (raw) {
    case "EQUITY":
      return "equity";
    case "ETF":
      return "etf";
    case "MUTUALFUND":
    case "MUTUAL_FUND":
      return "fund";
    case "INDEX":
      return "index";
    case "FUTURE":
    case "FUTURES":
      return "future";
    case "CRYPTOCURRENCY":
    case "CRYPTO":
      return "crypto";
    case "OPTION":
    case "OPTIONCHAIN":
      return "option";
    case "CURRENCY":
    case "EC":
      return "fx";
    case "BOND":
      return "bond";
    default:
      return "unknown";
  }
}

export function sanitizeLookupSymbols(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const symbol = item.trim().toUpperCase();
    if (!/^[$/^]?[A-Z0-9][A-Z0-9./^=\-]{0,15}$/.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
    if (out.length >= LOOKUP_SYMBOLS_MAX) break;
  }
  return out;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

interface YahooSearchQuote {
  symbol?: unknown;
  quoteType?: unknown;
  typeDisp?: unknown;
  shortname?: unknown;
  longname?: unknown;
  longName?: unknown;
  shortName?: unknown;
}

export function parseYahooSearchIdentity(payload: unknown, symbol: string): SymbolIdentity | null {
  const wanted = symbol.trim().toUpperCase();
  if (!wanted) return null;
  const root = payload && typeof payload === "object" ? payload as { quotes?: unknown } : null;
  const quotes = Array.isArray(root?.quotes) ? root.quotes : [];
  let fallback: YahooSearchQuote | null = null;
  for (const row of quotes) {
    if (!row || typeof row !== "object") continue;
    const quote = row as YahooSearchQuote;
    const sym = str(quote.symbol)?.toUpperCase();
    if (sym === wanted) return identityFromYahooQuote(quote, wanted);
    if (!fallback && sym && (sym.startsWith(`${wanted}.`) || wanted.startsWith(`${sym}.`))) {
      fallback = quote;
    }
  }
  return fallback ? identityFromYahooQuote(fallback, wanted) : null;
}

function identityFromYahooQuote(quote: YahooSearchQuote, symbol: string): SymbolIdentity {
  const name =
    str(quote.longname)
    ?? str(quote.longName)
    ?? str(quote.shortname)
    ?? str(quote.shortName);
  const kind = kindFromYahooQuoteType(str(quote.quoteType) ?? str(quote.typeDisp));
  return { symbol, name, kind, source: "yahoo" };
}

function identityFromCatalog(symbol: string): SymbolIdentity | null {
  const hit = catalogLookup(symbol);
  if (!hit) return null;
  return {
    symbol: hit.symbol,
    name: hit.name,
    kind: hit.kind,
    source: "catalog",
  };
}

async function fetchYahooSearchIdentity(
  symbol: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SymbolIdentity | null> {
  const url = new URL(YAHOO_SEARCH_URL);
  url.searchParams.set("q", symbol);
  url.searchParams.set("quotesCount", "8");
  url.searchParams.set("newsCount", "0");
  url.searchParams.set("listsCount", "0");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": YAHOO_UA,
      },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return parseYahooSearchIdentity(await resp.json(), symbol);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve one ticker: in-process catalog first (indexes/futures/crypto),
 * then Yahoo search for equities and funds the lake does not cover.
 */
export async function lookupSymbolIdentity(
  symbol: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<SymbolIdentity> {
  const ticker = symbol.trim().toUpperCase();
  const unknown: SymbolIdentity = { symbol: ticker || symbol, name: null, kind: "unknown", source: "none" };
  if (!ticker) return unknown;
  const catalog = identityFromCatalog(ticker);
  if (catalog) return catalog;
  const yahoo = await fetchYahooSearchIdentity(
    ticker,
    opts?.fetchImpl ?? fetch,
    opts?.timeoutMs ?? YAHOO_SEARCH_TIMEOUT_MS,
  );
  return yahoo ?? unknown;
}

export async function lookupSymbolIdentities(
  symbols: unknown,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<SymbolIdentity[]> {
  const list = sanitizeLookupSymbols(symbols);
  return Promise.all(list.map((symbol) => lookupSymbolIdentity(symbol, opts)));
}

export function formatSymbolIdentities(rows: SymbolIdentity[]): string {
  if (rows.length === 0) return "No symbols to identify.";
  const lines = [`Identified ${rows.length} symbol${rows.length === 1 ? "" : "s"}:`];
  for (const row of rows) {
    const name = row.name || "name unknown";
    const source = row.source === "none" ? "no lookup hit" : row.source;
    lines.push(`- ${row.symbol} · ${row.kind} · ${name} (${source})`);
  }
  return lines.join("\n");
}

/** True when a holding is a basket (ETF/fund/index), not a single issuer. */
export function isDiversifiedVehicle(kind: SymbolKind): boolean {
  return kind === "etf" || kind === "fund" || kind === "index";
}

const EMPTY_ETF_STUB = {
  name: null as string | null,
  family: null as string | null,
  category: null as string | null,
  net_assets: null as number | null,
  expense_ratio: null as number | null,
  holdings: [] as Array<{
    rank: number | null;
    holding_symbol: string | null;
    holding_name: string | null;
    weight: number | null;
  }>,
};

/** Fill a thin research identity with a lookup hit (name + ETF stub). */
export function applyLookupIdentity<T extends {
  identity: { name: string | null };
  etf: {
    name: string | null;
    family: string | null;
    category: string | null;
    net_assets: number | null;
    expense_ratio: number | null;
    holdings?: Array<{
      rank: number | null;
      holding_symbol: string | null;
      holding_name: string | null;
      weight: number | null;
    }>;
  } | null;
}>(research: T, id: SymbolIdentity): T {
  if (id.source === "none") return research;
  const identity = research.identity.name
    ? research.identity
    : { ...research.identity, name: id.name };
  const needsEtfStub = !research.etf && (id.kind === "etf" || id.kind === "fund");
  const etf = needsEtfStub
    ? { ...EMPTY_ETF_STUB, name: id.name, category: id.kind }
    : research.etf;
  return { ...research, identity, etf };
}
