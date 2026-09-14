/**
 * Solicit Kalshi RFQ quotes on sports parlay (MVE combo) markets and map the
 * private two-way onto existing kalshi_markets bid/ask columns.
 *
 * Listing other members' RFQs does not expose maker prices. Quotes are
 * private to the requester, so the durable way to fill the tape is:
 * create an RFQ → poll GET /communications/quotes?rfq_id=&rfq_user_filter=self
 * → DELETE the RFQ. Never accept or confirm (no execution).
 *
 * Cap is on same-game two-leg sports combos ranked by corr room
 * (Fréchet high − p×q). Do not RFQ the full sports catalog.
 */

import type { KalshiEnv, KalshiHttpResult, KalshiMarketRow } from "./kalshi.js";
import {
  DEFAULT_KALSHI_API_BASE,
  kalshiAuthConfigured,
  kalshiRequest,
  parseKalshiNumber,
} from "./kalshi.js";
import {
  mveLegKind,
  mveTapeKind,
  parlayGameGroup,
  sportsGameKey,
  type MveSelectedLeg,
} from "./kalshi-mve.js";

export const KALSHI_RFQ_SOURCE = "kalshi_rfq";
export const KALSHI_RFQ_PROBE_MAX_DEFAULT = 12;
export const KALSHI_RFQ_WAIT_MS_DEFAULT = 2500;
export const KALSHI_RFQ_POLL_MS_DEFAULT = 1000;
export const KALSHI_RFQ_POLLS_DEFAULT = 3;
export const KALSHI_RFQ_CONTRACTS_DEFAULT = 10;

export interface RfqTwoWay {
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  mid: number;
}

export interface RfqProbeTarget {
  market_ticker: string;
  corr_room: number;
  p: number;
  q: number;
}

type ComboLegs = Map<string, MveSelectedLeg[]>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

function envNumber(raw: unknown, dflt: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}

function envInt(raw: unknown, dflt: number, min: number, max: number): number {
  const n = envNumber(raw, dflt);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function truthyFlag(raw: unknown): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function rfqProbeEnabled(env: KalshiEnv): boolean {
  return kalshiAuthConfigured(env) && truthyFlag(env.KALSHI_RFQ_PROBE_ENABLED);
}

export function rfqProbeMax(env: KalshiEnv): number {
  return envInt(env.KALSHI_RFQ_PROBE_MAX, KALSHI_RFQ_PROBE_MAX_DEFAULT, 1, 20);
}

function rfqWaitMs(env: KalshiEnv): number {
  return envInt(env.KALSHI_RFQ_WAIT_MS, KALSHI_RFQ_WAIT_MS_DEFAULT, 0, 15_000);
}

function rfqPollMs(env: KalshiEnv): number {
  return envInt(env.KALSHI_RFQ_POLL_MS, KALSHI_RFQ_POLL_MS_DEFAULT, 0, 10_000);
}

function rfqPolls(env: KalshiEnv): number {
  return envInt(env.KALSHI_RFQ_POLLS, KALSHI_RFQ_POLLS_DEFAULT, 1, 8);
}

function rfqContractsFp(env: KalshiEnv): string {
  const n = envInt(env.KALSHI_RFQ_CONTRACTS, KALSHI_RFQ_CONTRACTS_DEFAULT, 1, 10);
  return `${n}.00`;
}

function kalshiBase(env: KalshiEnv): string {
  return (env.KALSHI_API_BASE || DEFAULT_KALSHI_API_BASE).replace(/\/$/, "");
}

function assertNotExecution(url: string): void {
  if (/\/(accept|confirm)(\/|$|\?)/i.test(url)) {
    throw new Error("kalshi rfq probe refuses accept/confirm");
  }
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function rfqRequest(
  method: string,
  url: string,
  env: KalshiEnv,
  label: string,
  body?: unknown,
): Promise<KalshiHttpResult> {
  assertNotExecution(url);
  return kalshiRequest(method, url, env, label, body);
}

export function comboHasTwoSidedBook(row: KalshiMarketRow): boolean {
  const bid = row.yes_bid;
  const ask = row.yes_ask;
  return bid != null && ask != null
    && Number.isFinite(bid) && Number.isFinite(ask)
    && bid > 0 && ask < 1 && ask >= bid;
}

function tradableYesMid(row: KalshiMarketRow | undefined): number | null {
  if (!row) return null;
  const bid = row.yes_bid;
  const ask = row.yes_ask;
  if (
    bid != null && ask != null
    && Number.isFinite(bid) && Number.isFinite(ask)
    && bid > 0 && ask < 1 && ask >= bid
  ) {
    return (bid + ask) / 2;
  }
  const last = row.yes_last;
  if (last != null && Number.isFinite(last) && last > 0 && last < 1) return last;
  if (bid != null && Number.isFinite(bid) && bid > 0 && bid < 1) return bid;
  if (ask != null && Number.isFinite(ask) && ask > 0 && ask < 1) return ask;
  return null;
}

function selectedProb(row: KalshiMarketRow | undefined, side: "yes" | "no"): number | null {
  const mid = tradableYesMid(row);
  if (mid == null) return null;
  return side === "no" ? 1 - mid : mid;
}

function corrRoom(p: number, q: number): number {
  return Math.max(0, Math.min(p, q) - p * q);
}

function isOpenCombo(row: KalshiMarketRow): boolean {
  return !/^(settled|finalized|closed)$/i.test(row.status);
}

function isSameGameSportsTwoLeg(legs: MveSelectedLeg[]): boolean {
  if (legs.length !== 2) return false;
  const tickers = legs.map((leg) => leg.market_ticker);
  if (mveTapeKind(tickers) !== "sports") return false;
  if (tickers.some((ticker) => mveLegKind(ticker) !== "sports")) return false;
  const games = legs.map((leg) => sportsGameKey(leg.market_ticker, leg.event_ticker));
  return parlayGameGroup(games) === "same_game";
}

function rankRfqTargets(a: RfqProbeTarget, b: RfqProbeTarget): number {
  if (b.corr_room !== a.corr_room) return b.corr_room - a.corr_room;
  return a.market_ticker < b.market_ticker ? -1 : a.market_ticker > b.market_ticker ? 1 : 0;
}

export function pickRfqProbeTargets(
  combos: KalshiMarketRow[],
  comboLegs: ComboLegs,
  legs: KalshiMarketRow[],
  cap: number,
): RfqProbeTarget[] {
  const byTicker = new Map(legs.map((row) => [row.market_ticker, row]));
  const needQuote: RfqProbeTarget[] = [];
  const haveClob: RfqProbeTarget[] = [];
  for (const combo of combos) {
    if (!isOpenCombo(combo)) continue;
    const spec = comboLegs.get(combo.market_ticker) ?? [];
    if (!isSameGameSportsTwoLeg(spec)) continue;
    const p = selectedProb(byTicker.get(spec[0]!.market_ticker), spec[0]!.side);
    const q = selectedProb(byTicker.get(spec[1]!.market_ticker), spec[1]!.side);
    if (p == null || q == null) continue;
    const target: RfqProbeTarget = {
      market_ticker: combo.market_ticker,
      corr_room: corrRoom(p, q),
      p,
      q,
    };
    if (comboHasTwoSidedBook(combo)) haveClob.push(target);
    else needQuote.push(target);
  }
  needQuote.sort(rankRfqTargets);
  haveClob.sort(rankRfqTargets);
  const capN = Math.max(0, cap);
  const out = needQuote.slice(0, capN);
  if (out.length < capN) out.push(...haveClob.slice(0, capN - out.length));
  return out;
}

function quoteStatus(raw: unknown): string {
  return strip(asRecord(raw)?.status).toLowerCase();
}

export function twoWayFromRfqQuotes(quotes: unknown[]): RfqTwoWay | null {
  const open = quotes.filter((raw) => {
    const status = quoteStatus(raw);
    return !status || status === "open";
  });

  let bestSingle: RfqTwoWay | null = null;
  let bestSingleSpread = Infinity;
  let bestYesBid = 0;
  let bestNoBid = 0;

  for (const raw of open) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const yesBid = parseKalshiNumber(rec.yes_bid_dollars ?? rec.yes_bid) ?? 0;
    const noBid = parseKalshiNumber(rec.no_bid_dollars ?? rec.no_bid) ?? 0;
    if (!(yesBid >= 0) || !(noBid >= 0) || (yesBid <= 0 && noBid <= 0)) continue;
    if (yesBid > bestYesBid) bestYesBid = yesBid;
    if (noBid > bestNoBid) bestNoBid = noBid;
    if (yesBid > 0 && noBid > 0 && yesBid + noBid <= 1 + 1e-9) {
      const yesAsk = 1 - noBid;
      if (yesAsk >= yesBid && yesAsk < 1) {
        const spread = yesAsk - yesBid;
        if (spread < bestSingleSpread) {
          bestSingleSpread = spread;
          bestSingle = {
            yes_bid: yesBid,
            yes_ask: yesAsk,
            no_bid: noBid,
            no_ask: 1 - yesBid,
            mid: (yesBid + yesAsk) / 2,
          };
        }
      }
    }
  }
  if (bestSingle) return bestSingle;
  if (bestYesBid <= 0 || bestNoBid <= 0) return null;
  const yesAsk = 1 - bestNoBid;
  if (!(yesAsk < 1) || yesAsk < 0) return null;
  if (yesAsk < bestYesBid) {
    const mid = (bestYesBid + yesAsk) / 2;
    return {
      yes_bid: mid,
      yes_ask: mid,
      no_bid: 1 - mid,
      no_ask: 1 - mid,
      mid,
    };
  }
  return {
    yes_bid: bestYesBid,
    yes_ask: yesAsk,
    no_bid: bestNoBid,
    no_ask: 1 - bestYesBid,
    mid: (bestYesBid + yesAsk) / 2,
  };
}

export function applyRfqTwoWay(row: KalshiMarketRow, quote: RfqTwoWay): KalshiMarketRow {
  return {
    ...row,
    yes_bid: quote.yes_bid,
    yes_ask: quote.yes_ask,
    yes_last: quote.mid,
    no_bid: quote.no_bid,
    no_ask: quote.no_ask,
    source: KALSHI_RFQ_SOURCE,
  };
}

function isForbidden(result: KalshiHttpResult): boolean {
  return result.status === 401 || result.status === 403;
}

function createRfqId(json: unknown): string | null {
  const rec = asRecord(json);
  return strip(rec?.id) || strip(asRecord(rec?.rfq)?.id) || null;
}

async function cancelRfq(env: KalshiEnv, rfqId: string): Promise<void> {
  try {
    const url = `${kalshiBase(env)}/communications/rfqs/${encodeURIComponent(rfqId)}`;
    const result = await rfqRequest("DELETE", url, env, `kalshi delete rfq ${rfqId}`);
    if (result.status === 204 || result.status === 200 || result.status === 404) return;
    if (isForbidden(result)) return;
  } catch {
    // Best-effort: leftover RFQs are replaced on the next pass.
  }
}

async function cancelOwnOpenRfqs(env: KalshiEnv): Promise<"ok" | "forbidden"> {
  try {
    const url = `${kalshiBase(env)}/communications/rfqs?user_filter=self&status=open&limit=100`;
    const result = await rfqRequest("GET", url, env, "kalshi list own rfqs");
    if (isForbidden(result)) return "forbidden";
    if (result.status < 200 || result.status >= 300) return "ok";
    const rfqs = asRecord(result.json)?.rfqs;
    if (!Array.isArray(rfqs)) return "ok";
    for (const raw of rfqs) {
      const id = strip(asRecord(raw)?.id);
      if (id) await cancelRfq(env, id);
    }
    return "ok";
  } catch {
    return "ok";
  }
}

async function fetchQuotesForRfq(env: KalshiEnv, rfqId: string): Promise<unknown[]> {
  try {
    const url = `${kalshiBase(env)}/communications/quotes?rfq_id=${encodeURIComponent(rfqId)}&rfq_user_filter=self&limit=100`;
    const result = await rfqRequest("GET", url, env, `kalshi rfq quotes ${rfqId}`);
    if (result.status < 200 || result.status >= 300) {
      console.warn(`kalshi rfq probe: quotes http=${result.status}`);
      return [];
    }
    const quotes = asRecord(result.json)?.quotes;
    return Array.isArray(quotes) ? quotes : [];
  } catch {
    return [];
  }
}

async function createRfq(env: KalshiEnv, marketTicker: string): Promise<{
  id: string | null;
  forbidden: boolean;
}> {
  try {
    const url = `${kalshiBase(env)}/communications/rfqs`;
    const body = {
      market_ticker: marketTicker,
      contracts_fp: rfqContractsFp(env),
      rest_remainder: false,
      replace_existing: true,
    };
    const result = await rfqRequest("POST", url, env, `kalshi create rfq ${marketTicker}`, body);
    if (isForbidden(result)) return { id: null, forbidden: true };
    if (result.status === 201 || result.status === 200) {
      return { id: createRfqId(result.json), forbidden: false };
    }
    if (result.status === 409) {
      const listed = await rfqRequest(
        "GET",
        `${kalshiBase(env)}/communications/rfqs?market_ticker=${encodeURIComponent(marketTicker)}&user_filter=self&status=open&limit=10`,
        env,
        `kalshi rfq conflict ${marketTicker}`,
      );
      const rfqs = asRecord(listed.json)?.rfqs;
      if (Array.isArray(rfqs)) {
        for (const raw of rfqs) {
          const id = strip(asRecord(raw)?.id);
          if (id) await cancelRfq(env, id);
        }
      }
      const retry = await rfqRequest("POST", url, env, `kalshi create rfq retry ${marketTicker}`, body);
      if (isForbidden(retry)) return { id: null, forbidden: true };
      if (retry.status === 201 || retry.status === 200) {
        return { id: createRfqId(retry.json), forbidden: false };
      }
    }
    return { id: null, forbidden: false };
  } catch {
    return { id: null, forbidden: false };
  }
}

async function probeOneCombo(env: KalshiEnv, marketTicker: string): Promise<{
  twoWay: RfqTwoWay | null;
  forbidden: boolean;
}> {
  const created = await createRfq(env, marketTicker);
  if (created.forbidden) return { twoWay: null, forbidden: true };
  const rfqId = created.id;
  if (!rfqId) {
    console.warn(`kalshi rfq probe: ${marketTicker} create returned no id`);
    return { twoWay: null, forbidden: false };
  }
  try {
    await sleep(rfqWaitMs(env));
    const polls = rfqPolls(env);
    for (let i = 0; i < polls; i++) {
      if (i > 0) await sleep(rfqPollMs(env));
      const quotes = await fetchQuotesForRfq(env, rfqId);
      const twoWay = twoWayFromRfqQuotes(quotes);
      if (quotes.length > 0) {
        console.warn(
          `kalshi rfq probe: ${marketTicker} poll=${i + 1} quotes=${quotes.length} twoWay=${!!twoWay}`,
        );
      }
      if (twoWay) return { twoWay, forbidden: false };
    }
    console.warn(`kalshi rfq probe: ${marketTicker} no two-way after ${polls} polls`);
    return { twoWay: null, forbidden: false };
  } finally {
    await cancelRfq(env, rfqId);
  }
}

/**
 * Overlay solicited RFQ two-ways onto open same-game combo rows.
 * Read-only keys / missing trading permission skip the pass (403) without
 * failing ingest. Never accepts a quote.
 */
export async function probeKalshiRfqQuotes(
  env: KalshiEnv,
  combos: KalshiMarketRow[],
  comboLegs: ComboLegs,
  legs: KalshiMarketRow[],
): Promise<KalshiMarketRow[]> {
  if (!rfqProbeEnabled(env) || combos.length === 0) return combos;
  const targets = pickRfqProbeTargets(combos, comboLegs, legs, rfqProbeMax(env));
  if (targets.length === 0) return combos;

  try {
    const cleanup = await cancelOwnOpenRfqs(env);
    if (cleanup === "forbidden") {
      console.warn("kalshi rfq probe: skipped communications 401/403 (need write::trade)");
      return combos;
    }

    const byTicker = new Map(combos.map((row) => [row.market_ticker, row]));
    let filled = 0;
    let forbidden = false;
    for (const target of targets) {
      try {
        const result = await probeOneCombo(env, target.market_ticker);
        if (result.forbidden) {
          forbidden = true;
          break;
        }
        if (!result.twoWay) continue;
        const row = byTicker.get(target.market_ticker);
        if (!row) continue;
        byTicker.set(target.market_ticker, applyRfqTwoWay(row, result.twoWay));
        filled += 1;
      } catch {
        // Keep ingesting remaining targets; RFQ is best-effort.
      }
    }
    console.warn(
      `kalshi rfq probe: filled ${filled}/${targets.length} same-game combos${forbidden ? " (create 401/403)" : ""}`,
    );
    return combos.map((row) => byTicker.get(row.market_ticker) ?? row);
  } catch (error) {
    console.warn(`kalshi rfq probe: aborted ${error instanceof Error ? error.message : String(error)}`.slice(0, 240));
    return combos;
  }
}
