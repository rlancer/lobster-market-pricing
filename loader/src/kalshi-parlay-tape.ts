/**
 * Publish executor combo fills + this pass's RFQ two-ways onto
 * options.kalshi_markets. Loader-only — imports kalshi.ts.
 */

import {
  DEFAULT_KALSHI_API_BASE,
  kalshiRequest,
  mapKalshiMarketRaw,
  type KalshiEnv,
  type KalshiMarketRow,
} from "./kalshi.js";
import {
  encodeMveCategory,
  mveCollectionTicker,
  parseMveSelectedLegs,
} from "./kalshi-mve.js";
import { applyRfqTwoWay } from "./kalshi-rfq-quotes.js";
import { asSettlementSnapshot, isKalshiSettledStatus } from "./kalshi-settlement.js";
import {
  fillToMarketRow,
  parseKalshiPortfolioFill,
  parseKalshiPortfolioSettlement,
  settlementYesFromFill,
  type ParlayExecutorQuote,
  type ParlayFillMarketRow,
  type ParlayPortfolioFill,
  type ParlayPortfolioSettlement,
} from "./kalshi-parlay-fills.js";

export type { ParlayExecutorQuote } from "./kalshi-parlay-fills.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

function kalshiBase(env: KalshiEnv): string {
  return (env.KALSHI_API_BASE || DEFAULT_KALSHI_API_BASE).replace(/\/$/, "");
}

function categoryFromMarketRaw(raw: unknown): string | null {
  const legs = parseMveSelectedLegs(raw);
  if (legs.length < 2) return null;
  return encodeMveCategory(mveCollectionTicker(raw) || "KXMVE", legs);
}

async function fetchMarketRawByTickers(
  tickers: string[],
  env: KalshiEnv,
): Promise<Map<string, unknown>> {
  const base = kalshiBase(env);
  const unique = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  const out = new Map<string, unknown>();
  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    const url = `${base}/markets?tickers=${encodeURIComponent(chunk.join(","))}&limit=200`;
    const result = await kalshiRequest("GET", url, env, `kalshi parlay tape markets ${i}`);
    const markets = asRecord(result.json)?.markets;
    if (!Array.isArray(markets)) continue;
    for (const raw of markets) {
      const ticker = strip(asRecord(raw)?.ticker).toUpperCase();
      if (ticker) out.set(ticker, raw);
    }
  }
  return out;
}

function mappedFromRaw(raw: unknown): KalshiMarketRow | null {
  return mapKalshiMarketRaw(raw, { theme: "sports", related_symbol: null });
}

function asKalshiRow(row: ParlayFillMarketRow): KalshiMarketRow {
  return row as KalshiMarketRow;
}

export async function fetchKalshiPortfolioFills(env: KalshiEnv): Promise<ParlayPortfolioFill[]> {
  const out: ParlayPortfolioFill[] = [];
  const seen = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: "200" });
    if (cursor) qs.set("cursor", cursor);
    const url = `${kalshiBase(env)}/portfolio/fills?${qs.toString()}`;
    const result = await kalshiRequest("GET", url, env, "kalshi portfolio fills");
    const rec = asRecord(result.json);
    const fills = rec?.fills;
    if (!Array.isArray(fills)) break;
    for (const raw of fills) {
      const fill = parseKalshiPortfolioFill(raw);
      if (!fill) continue;
      const key = `${fill.market_ticker}|${fill.created_time}|${fill.side}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(fill);
    }
    const next = strip(rec?.cursor);
    if (!next || next === cursor || fills.length < 200) break;
    cursor = next;
  }
  return out;
}

export async function fetchKalshiPortfolioSettlements(
  env: KalshiEnv,
): Promise<ParlayPortfolioSettlement[]> {
  const url = `${kalshiBase(env)}/portfolio/settlements?limit=200`;
  const result = await kalshiRequest("GET", url, env, "kalshi portfolio settlements");
  const rows = asRecord(result.json)?.settlements;
  if (!Array.isArray(rows)) return [];
  return rows.map(parseKalshiPortfolioSettlement).filter(
    (row): row is ParlayPortfolioSettlement => row != null,
  );
}

export function marketRowsFromParlayFills(
  fills: ParlayPortfolioFill[],
  settlements: ParlayPortfolioSettlement[],
  marketRaw: Map<string, unknown>,
): KalshiMarketRow[] {
  const byTicker = new Map(settlements.map((row) => [row.market_ticker, row]));
  const out: KalshiMarketRow[] = [];
  for (const fill of fills) {
    const raw = marketRaw.get(fill.market_ticker);
    const mapped = raw ? mappedFromRaw(raw) : null;
    const category = raw ? categoryFromMarketRaw(raw) : mapped?.category ?? null;
    out.push(asKalshiRow(fillToMarketRow(fill, mapped, category)));
    const settled = byTicker.get(fill.market_ticker);
    const yes = settlementYesFromFill(fill, settled?.revenue ?? null);
    if (yes !== 0 && yes !== 1) continue;
    const snap = asSettlementSnapshot({
      ...(mapped ?? asKalshiRow(fillToMarketRow(fill, mapped, category))),
      status: "settled",
      yes_bid: yes,
      yes_ask: yes,
      yes_last: yes,
      no_bid: 1 - yes,
      no_ask: 1 - yes,
      category,
      source: "kalshi",
      fetched_at: settled?.settled_time || fill.created_time,
      close_time: settled?.settled_time || mapped?.close_time || null,
      result: yes === 1 ? "yes" : "no",
    });
    if (snap) out.push(snap);
  }
  return out;
}

export function rfqRowsFromExecutorQuotes(
  quotes: ParlayExecutorQuote[],
  marketRaw: Map<string, unknown>,
): KalshiMarketRow[] {
  const out: KalshiMarketRow[] = [];
  for (const quote of quotes) {
    const ticker = quote.market_ticker.trim().toUpperCase();
    if (!ticker || quote.yes_bid == null || quote.yes_ask == null) continue;
    if (!(quote.yes_ask > 0) || quote.yes_ask >= 1 || quote.yes_ask < quote.yes_bid) continue;
    const raw = marketRaw.get(ticker);
    const mapped = raw ? mappedFromRaw(raw) : null;
    const category = raw ? categoryFromMarketRaw(raw) : mapped?.category ?? null;
    const base: KalshiMarketRow = mapped ?? {
      series_ticker: ticker.match(/^(KX[A-Z]+)/)?.[1] ?? "KXMVE",
      market_ticker: ticker,
      event_ticker: null,
      title: ticker,
      yes_subtitle: null,
      theme: "sports",
      category,
      status: "active",
      market_type: "multivariate",
      yes_bid: quote.yes_bid,
      yes_ask: quote.yes_ask,
      yes_last: (quote.yes_bid + quote.yes_ask) / 2,
      no_bid: 1 - quote.yes_ask,
      no_ask: 1 - quote.yes_bid,
      volume: null,
      volume_24h: null,
      open_interest: null,
      liquidity: null,
      floor_strike: null,
      close_time: null,
      expiration_time: null,
      related_symbol: null,
      source: "kalshi",
    };
    out.push(applyRfqTwoWay(
      { ...base, category: category ?? base.category },
      {
        yes_bid: quote.yes_bid,
        yes_ask: quote.yes_ask,
        no_bid: 1 - quote.yes_ask,
        no_ask: 1 - quote.yes_bid,
        mid: (quote.yes_bid + quote.yes_ask) / 2,
        quote_id: "executor",
      },
    ));
  }
  return out;
}

/** Combo 0/1 from Get Markets for tickers that already have RFQ/fill in this pass. */
export function settlementRowsFromMarketRaw(
  tickers: string[],
  marketRaw: Map<string, unknown>,
): KalshiMarketRow[] {
  const out: KalshiMarketRow[] = [];
  const seen = new Set<string>();
  for (const rawTicker of tickers) {
    const ticker = rawTicker.trim().toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    const raw = marketRaw.get(ticker);
    if (!raw) continue;
    const mapped = mappedFromRaw(raw);
    if (!mapped || !isKalshiSettledStatus(mapped.status)) continue;
    const category = categoryFromMarketRaw(raw);
    const snap = asSettlementSnapshot({
      ...mapped,
      category: category ?? mapped.category,
    });
    if (snap) out.push(snap);
  }
  return out;
}

/**
 * Portfolio combo fills + inferred settlements + this pass's RFQ two-ways.
 * Swallows individual Kalshi errors so a 429 cannot fail the executor pass.
 * LIVE=0 still publishes solicited two-ways; it does not accept.
 */
export async function collectKalshiParlayTape(
  env: KalshiEnv,
  quotes: ParlayExecutorQuote[] = [],
): Promise<KalshiMarketRow[]> {
  let fills: ParlayPortfolioFill[] = [];
  let settlements: ParlayPortfolioSettlement[] = [];
  try {
    fills = await fetchKalshiPortfolioFills(env);
  } catch (error) {
    console.warn(`kalshi parlay tape: fills ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    settlements = await fetchKalshiPortfolioSettlements(env);
  } catch (error) {
    console.warn(`kalshi parlay tape: settlements ${error instanceof Error ? error.message : String(error)}`);
  }
  const tickers = [
    ...fills.map((row) => row.market_ticker),
    ...quotes.map((row) => row.market_ticker),
  ];
  let marketRaw = new Map<string, unknown>();
  if (tickers.length) {
    try {
      marketRaw = await fetchMarketRawByTickers(tickers, env);
    } catch (error) {
      console.warn(`kalshi parlay tape: markets ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [
    ...marketRowsFromParlayFills(fills, settlements, marketRaw),
    ...rfqRowsFromExecutorQuotes(quotes, marketRaw),
    ...settlementRowsFromMarketRaw(tickers, marketRaw),
  ];
}
