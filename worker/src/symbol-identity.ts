/**
 * Identify what a ticker actually is (equity vs ETF vs index vs …) and, for
 * funds, what it holds.
 *
 * Lake coverage is incomplete — RSP, VGSH, and other funds are often absent
 * from options.etf_profiles / etf_holdings. Yahoo search returns quoteType +
 * name without a crumb; quoteSummary (crumb session) returns the top-10 book
 * so this turn can see constituents before the lake flush. lookup_symbols
 * then enrolls the fund so etf-daily persists the same rows to the lake.
 */

import { catalogLookup } from "./catalog-symbols";
import { YAHOO_UA } from "./yahoo-intraday";

export const LOOKUP_SYMBOLS_MAX = 20;
export const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
export const YAHOO_SEARCH_TIMEOUT_MS = 8_000;
export const YAHOO_COOKIE_URL = "https://fc.yahoo.com";
export const YAHOO_CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";
export const YAHOO_QUOTE_SUMMARY_TEMPLATE =
  "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}" +
  "?modules=fundProfile,topHoldings,summaryDetail,defaultKeyStatistics&crumb={crumb}";
export const YAHOO_HOLDINGS_TIMEOUT_MS = 12_000;

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

export interface EtfHoldingPreview {
  rank: number | null;
  holding_symbol: string | null;
  holding_name: string | null;
  weight: number | null;
}

export interface EtfComposition {
  family: string | null;
  category: string | null;
  net_assets: number | null;
  expense_ratio: number | null;
  holdings: EtfHoldingPreview[];
}

export interface SymbolIdentity {
  symbol: string;
  name: string | null;
  kind: SymbolKind;
  source: IdentitySource;
  family?: string | null;
  category?: string | null;
  net_assets?: number | null;
  expense_ratio?: number | null;
  holdings?: EtfHoldingPreview[];
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rawNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const rec = asRecord(value);
  if (!rec) return null;
  const raw = rec.raw;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
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

function cookieFrom(res: Response): string {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    const parts = headers.getSetCookie().map((c) => c.split(";")[0]).filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  const one = headers.get("set-cookie");
  return one ? one.split(";")[0].trim() : "";
}

interface YahooSession {
  cookie: string;
  crumb: string;
}

async function openYahooSession(fetchImpl: typeof fetch): Promise<YahooSession> {
  const cookieRes = await fetchImpl(YAHOO_COOKIE_URL, {
    headers: { "user-agent": YAHOO_UA },
    redirect: "manual",
  });
  const cookie = cookieFrom(cookieRes);
  if (!cookie) throw new Error("yahoo cookie missing");
  const crumbRes = await fetchImpl(YAHOO_CRUMB_URL, {
    headers: { "user-agent": YAHOO_UA, cookie, accept: "text/plain" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!crumbRes.ok) throw new Error(`yahoo crumb HTTP ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.startsWith("{") || crumb.includes(" ")) {
    throw new Error(`yahoo crumb invalid: ${crumb.slice(0, 40)}`);
  }
  return { cookie, crumb };
}

/** Parse Yahoo quoteSummary fundProfile + topHoldings. Returns null when empty. */
export function parseYahooEtfComposition(payload: unknown): EtfComposition | null {
  const root = asRecord(payload);
  const qs = asRecord(root?.quoteSummary);
  const result = Array.isArray(qs?.result) ? asRecord(qs.result[0]) : null;
  if (!result) return null;
  const fund = asRecord(result.fundProfile);
  const fees = asRecord(fund?.feesExpensesInvestment);
  const stats = asRecord(result.defaultKeyStatistics);
  const top = asRecord(result.topHoldings);
  const rows = Array.isArray(top?.holdings) ? top.holdings : [];
  const holdings: EtfHoldingPreview[] = [];
  rows.forEach((row, idx) => {
    const rec = asRecord(row);
    if (!rec) return;
    const holdingSymbol = typeof rec.symbol === "string" && rec.symbol.trim()
      ? rec.symbol.trim().toUpperCase()
      : null;
    const holdingName = typeof rec.holdingName === "string" && rec.holdingName.trim()
      ? rec.holdingName.trim()
      : null;
    holdings.push({
      rank: idx + 1,
      holding_symbol: holdingSymbol,
      holding_name: holdingName,
      weight: rawNum(rec.holdingPercent),
    });
  });
  const family = typeof fund?.family === "string" && fund.family.trim() ? fund.family.trim() : null;
  const category = typeof fund?.categoryName === "string" && fund.categoryName.trim()
    ? fund.categoryName.trim()
    : null;
  const netAssets = rawNum(stats?.totalAssets) ?? rawNum(fees?.totalNetAssets);
  const expenseRatio = rawNum(fees?.annualReportExpenseRatio) ?? rawNum(fees?.netExpRatio);
  if (!holdings.length && !family && !category && netAssets == null && expenseRatio == null) {
    return null;
  }
  return {
    family,
    category,
    net_assets: netAssets,
    expense_ratio: expenseRatio,
    holdings,
  };
}

async function fetchYahooEtfComposition(
  symbol: string,
  session: YahooSession,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<EtfComposition | null> {
  const url = YAHOO_QUOTE_SUMMARY_TEMPLATE
    .replace("{symbol}", encodeURIComponent(symbol))
    .replace("{crumb}", encodeURIComponent(session.crumb));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": YAHOO_UA,
        cookie: session.cookie,
      },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    return parseYahooEtfComposition(await resp.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function applyComposition(id: SymbolIdentity, composition: EtfComposition): SymbolIdentity {
  return {
    ...id,
    family: composition.family,
    category: composition.category,
    net_assets: composition.net_assets,
    expense_ratio: composition.expense_ratio,
    holdings: composition.holdings,
  };
}

async function attachFundHoldings(
  rows: SymbolIdentity[],
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SymbolIdentity[]> {
  const funds = rows.filter((row) => row.kind === "etf" || row.kind === "fund");
  if (funds.length === 0) return rows;
  let session: YahooSession;
  try {
    session = await openYahooSession(fetchImpl);
  } catch {
    return rows;
  }
  const bySymbol = new Map<string, EtfComposition>();
  await Promise.all(funds.map(async (row) => {
    const composition = await fetchYahooEtfComposition(row.symbol, session, fetchImpl, timeoutMs);
    if (composition) bySymbol.set(row.symbol, composition);
  }));
  if (bySymbol.size === 0) return rows;
  return rows.map((row) => {
    const composition = bySymbol.get(row.symbol);
    return composition ? applyComposition(row, composition) : row;
  });
}

export interface LookupOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Fetch Yahoo top holdings for ETF/fund hits. Default true. */
  includeHoldings?: boolean;
}

/**
 * Resolve one ticker: in-process catalog first (indexes/futures/crypto),
 * then Yahoo search for equities and funds the lake does not cover.
 * ETF/fund hits also pull Yahoo topHoldings (crumb session).
 */
export async function lookupSymbolIdentity(
  symbol: string,
  opts?: LookupOpts,
): Promise<SymbolIdentity> {
  const ticker = symbol.trim().toUpperCase();
  const unknown: SymbolIdentity = { symbol: ticker || symbol, name: null, kind: "unknown", source: "none" };
  if (!ticker) return unknown;
  const catalog = identityFromCatalog(ticker);
  const identity = catalog ?? await fetchYahooSearchIdentity(
    ticker,
    opts?.fetchImpl ?? fetch,
    opts?.timeoutMs ?? YAHOO_SEARCH_TIMEOUT_MS,
  ) ?? unknown;
  if (opts?.includeHoldings === false) return identity;
  const [withHoldings] = await attachFundHoldings(
    [identity],
    opts?.fetchImpl ?? fetch,
    opts?.timeoutMs ?? YAHOO_HOLDINGS_TIMEOUT_MS,
  );
  return withHoldings ?? identity;
}

export async function lookupSymbolIdentities(
  symbols: unknown,
  opts?: LookupOpts,
): Promise<SymbolIdentity[]> {
  const list = sanitizeLookupSymbols(symbols);
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const identities = await Promise.all(
    list.map((symbol) => lookupSymbolIdentity(symbol, { ...opts, fetchImpl, includeHoldings: false })),
  );
  if (opts?.includeHoldings === false) return identities;
  return attachFundHoldings(
    identities,
    fetchImpl,
    opts?.timeoutMs ?? YAHOO_HOLDINGS_TIMEOUT_MS,
  );
}

/** Format a Yahoo holdingPercent (usually 0.002 = 0.20%) for the model. */
export function formatHoldingWeight(weight: number | null | undefined): string {
  if (weight == null || !Number.isFinite(weight)) return "?";
  const pct = Math.abs(weight) <= 1 ? weight * 100 : weight;
  const digits = Math.abs(pct) >= 10 ? 1 : 2;
  return `${pct.toFixed(digits)}%`;
}

function formatAum(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${Math.round(n / 1e6)}M`;
  return `$${Math.round(n)}`;
}

function formatExpenseRatio(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const pct = Math.abs(n) <= 1 ? n * 100 : n;
  return `${pct.toFixed(2)}% ER`;
}

export function formatSymbolIdentities(rows: SymbolIdentity[]): string {
  if (rows.length === 0) return "No symbols to identify.";
  const lines = [`Identified ${rows.length} symbol${rows.length === 1 ? "" : "s"}:`];
  for (const row of rows) {
    const name = row.name || "name unknown";
    const source = row.source === "none" ? "no lookup hit" : row.source;
    lines.push(`- ${row.symbol} · ${row.kind} · ${name} (${source})`);
    if (row.kind === "etf" || row.kind === "fund") {
      const meta: string[] = [];
      if (row.family) meta.push(row.family);
      if (row.category) meta.push(row.category);
      const aum = formatAum(row.net_assets);
      if (aum) meta.push(`AUM ${aum}`);
      const er = formatExpenseRatio(row.expense_ratio);
      if (er) meta.push(er);
      if (meta.length) lines.push(`  ${meta.join(" · ")}`);
      const holdings = row.holdings || [];
      if (holdings.length) {
        const parts = holdings.slice(0, 10).map((h) => {
          const label = h.holding_symbol || h.holding_name || "?";
          return `${label} ${formatHoldingWeight(h.weight)}`;
        });
        lines.push(`  top holdings (Yahoo top-10, not the full book): ${parts.join(", ")}`);
      } else {
        lines.push("  top holdings unavailable this turn — query options.etf_holdings after lake ingest, or retry lookup_symbols.");
      }
    }
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
  holdings: [] as EtfHoldingPreview[],
};

/** Fill a thin research identity with a lookup hit (name + ETF stub/holdings). */
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
    [key: string]: unknown;
  } | null;
}>(research: T, id: SymbolIdentity): T {
  if (id.source === "none") return research;
  const identity = research.identity.name
    ? research.identity
    : { ...research.identity, name: id.name };
  const isFund = id.kind === "etf" || id.kind === "fund";
  const holdings = id.holdings && id.holdings.length
    ? id.holdings
    : (research.etf?.holdings ?? []);
  if (!isFund && !research.etf) {
    return { ...research, identity };
  }
  const base = research.etf ?? { ...EMPTY_ETF_STUB, name: id.name, category: id.kind };
  const etf = {
    ...base,
    name: base.name || id.name,
    family: id.family ?? base.family,
    category: id.category ?? base.category,
    net_assets: id.net_assets ?? base.net_assets,
    expense_ratio: id.expense_ratio ?? base.expense_ratio,
    holdings,
  };
  return { ...research, identity, etf };
}
