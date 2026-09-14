/**
 * Kalshi same-game parlay executor.
 *
 * Separate from kalshi-markets-hourly / the RFQ research probe:
 *   1. Fetch open MVE combos + selected legs (no candle backfill, no probe).
 *   2. Rank same-game two-leg sports stacks by corr room.
 *   3. Create an RFQ, wait for a private two-way, score it.
 *   4. Default: log would_accept and DELETE the RFQ.
 *   5. Live fill: PUT .../quotes/{id}/accept { accepted_side: "yes" } only when
 *      KALSHI_PARLAY_EXECUTE=1 AND KALSHI_PARLAY_LIVE=1. The maker confirms
 *      (HVM 3s). This module never calls /confirm.
 *
 * Do not ingest the full sports catalog. Chat suggest_trades stays investing-only.
 */

import type { KalshiEnv, KalshiMarketRow } from "./kalshi.js";
import {
  DEFAULT_KALSHI_API_BASE,
  fetchKalshiSportsParlays,
  kalshiAuthConfigured,
  kalshiRequest,
} from "./kalshi.js";
import { parseMveCategory, type MveSelectedLeg } from "./kalshi-mve.js";
import {
  evaluateParlayQuote,
  parlayExecuteEnabled,
  parlayLiveEnabled,
  type ParlayQuoteDecision,
} from "./kalshi-parlay-filter.js";
import {
  cancelKalshiRfq,
  pickRfqProbeTargets,
  rfqProbeMax,
  solicitRfqTwoWay,
  type RfqProbeTarget,
  type RfqTwoWay,
} from "./kalshi-rfq-quotes.js";

export interface ParlayExecutorDecision {
  market_ticker: string;
  live: boolean;
  accepted: boolean;
  would_accept: boolean;
  rfq_id: string | null;
  quote_id: string | null;
  yes_bid: number | null;
  yes_ask: number | null;
  filter: ParlayQuoteDecision | null;
  error: string | null;
}

export interface ParlayExecutorPass {
  attempted: number;
  would_accept: number;
  accepted: number;
  skipped: number;
  decisions: ParlayExecutorDecision[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

function kalshiBase(env: KalshiEnv): string {
  return (env.KALSHI_API_BASE || DEFAULT_KALSHI_API_BASE).replace(/\/$/, "");
}

function comboLegsFromRows(combos: KalshiMarketRow[]): Map<string, MveSelectedLeg[]> {
  const out = new Map<string, MveSelectedLeg[]>();
  for (const row of combos) {
    const parsed = parseMveCategory(row.category);
    if (parsed?.legs.length) out.set(row.market_ticker, parsed.legs);
  }
  return out;
}

export function splitOpenSportsRows(rows: KalshiMarketRow[]): {
  combos: KalshiMarketRow[];
  legs: KalshiMarketRow[];
} {
  const combos = rows.filter((row) => {
    const category = row.category ?? "";
    return row.market_type === "multivariate" || category.startsWith("mve|");
  });
  const comboTickers = new Set(combos.map((row) => row.market_ticker));
  const legs = rows.filter((row) => !comboTickers.has(row.market_ticker));
  return { combos, legs };
}

export function decisionFromTwoWay(
  target: RfqProbeTarget,
  legs: MveSelectedLeg[] | undefined,
  twoWay: RfqTwoWay,
): ParlayQuoteDecision {
  const sides = (legs ?? []).map((leg) => leg.side);
  return evaluateParlayQuote({
    market_ticker: target.market_ticker,
    same_game: true,
    sides,
    p: target.p,
    q: target.q,
    yes_bid: twoWay.yes_bid,
    yes_ask: twoWay.yes_ask,
    quote_id: twoWay.quote_id,
  });
}

export async function acceptParlayQuote(
  env: KalshiEnv,
  rfqId: string,
  quoteId: string,
): Promise<void> {
  if (!parlayLiveEnabled(env)) {
    throw new Error(
      "kalshi parlay executor refuses accept unless KALSHI_PARLAY_EXECUTE=1 and KALSHI_PARLAY_LIVE=1",
    );
  }
  const url = `${kalshiBase(env)}/communications/rfqs/${encodeURIComponent(rfqId)}/quotes/${encodeURIComponent(quoteId)}/accept`;
  const result = await kalshiRequest("PUT", url, env, `kalshi accept rfq ${rfqId}`, {
    accepted_side: "yes",
  });
  if (result.status !== 204 && result.status !== 200) {
    throw new Error(`kalshi accept rfq returned HTTP ${result.status}: ${result.text.slice(0, 160)}`);
  }
}

async function cancelOwnOpenRfqs(env: KalshiEnv): Promise<"ok" | "forbidden"> {
  try {
    const url = `${kalshiBase(env)}/communications/rfqs?user_filter=self&status=open&limit=100`;
    const result = await kalshiRequest("GET", url, env, "kalshi list own rfqs");
    if (result.status === 401 || result.status === 403) return "forbidden";
    if (result.status < 200 || result.status >= 300) return "ok";
    const rfqs = asRecord(result.json)?.rfqs;
    if (!Array.isArray(rfqs)) return "ok";
    for (const raw of rfqs) {
      const id = strip(asRecord(raw)?.id);
      if (id) await cancelKalshiRfq(env, id);
    }
    return "ok";
  } catch {
    return "ok";
  }
}

async function executeOne(
  env: KalshiEnv,
  target: RfqProbeTarget,
  legs: MveSelectedLeg[] | undefined,
  live: boolean,
): Promise<ParlayExecutorDecision> {
  const base: ParlayExecutorDecision = {
    market_ticker: target.market_ticker,
    live,
    accepted: false,
    would_accept: false,
    rfq_id: null,
    quote_id: null,
    yes_bid: null,
    yes_ask: null,
    filter: null,
    error: null,
  };
  const solicited = await solicitRfqTwoWay(env, target.market_ticker);
  base.rfq_id = solicited.rfqId;
  if (solicited.forbidden) {
    base.error = "forbidden";
    return base;
  }
  try {
    if (!solicited.twoWay) {
      base.error = "no_two_way";
      return base;
    }
    base.yes_bid = solicited.twoWay.yes_bid;
    base.yes_ask = solicited.twoWay.yes_ask;
    base.quote_id = solicited.twoWay.quote_id;
    const filter = decisionFromTwoWay(target, legs, solicited.twoWay);
    base.filter = filter;
    base.would_accept = filter.ok;
    if (!filter.ok) return base;
    if (!live) {
      console.warn(
        `kalshi parlay executor: would_accept ${target.market_ticker} ask=${solicited.twoWay.yes_ask.toFixed(3)} indep=${filter.independence.toFixed(3)} room=${filter.corr_room.toFixed(3)}`,
      );
      return base;
    }
    if (!solicited.rfqId || !solicited.twoWay.quote_id) {
      base.error = "no_quote_id";
      return base;
    }
    await acceptParlayQuote(env, solicited.rfqId, solicited.twoWay.quote_id);
    base.accepted = true;
    console.warn(`kalshi parlay executor: accepted YES ${target.market_ticker} quote=${solicited.twoWay.quote_id}`);
    return base;
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
    return base;
  } finally {
    if (solicited.rfqId && !base.accepted) await cancelKalshiRfq(env, solicited.rfqId);
  }
}

/**
 * One executor pass. No-ops unless KALSHI_PARLAY_EXECUTE=1.
 * Accepts only when KALSHI_PARLAY_LIVE=1 as well.
 */
export async function runKalshiParlayExecutorPass(
  env: KalshiEnv = {},
): Promise<ParlayExecutorPass> {
  const empty: ParlayExecutorPass = {
    attempted: 0,
    would_accept: 0,
    accepted: 0,
    skipped: 0,
    decisions: [],
  };
  if (!parlayExecuteEnabled(env)) return empty;
  if (!kalshiAuthConfigured(env)) {
    console.warn("kalshi parlay executor: skipped (no API keys)");
    return empty;
  }

  const live = parlayLiveEnabled(env);
  const rows = await fetchKalshiSportsParlays({
    ...env,
    KALSHI_RFQ_PROBE_ENABLED: "0",
    KALSHI_SPORTS_LOOKBACK_DAYS: 0,
  });
  const { combos, legs } = splitOpenSportsRows(rows);
  const comboLegs = comboLegsFromRows(combos);
  const targets = pickRfqProbeTargets(combos, comboLegs, legs, rfqProbeMax(env));
  if (targets.length === 0) return empty;

  const cleanup = await cancelOwnOpenRfqs(env);
  if (cleanup === "forbidden") {
    console.warn("kalshi parlay executor: skipped communications 401/403 (need write::trade)");
    return empty;
  }

  const decisions: ParlayExecutorDecision[] = [];
  for (const target of targets) {
    const decision = await executeOne(env, target, comboLegs.get(target.market_ticker), live);
    decisions.push(decision);
    if (decision.error === "forbidden") break;
  }

  const pass: ParlayExecutorPass = {
    attempted: decisions.length,
    would_accept: decisions.filter((row) => row.would_accept).length,
    accepted: decisions.filter((row) => row.accepted).length,
    skipped: decisions.filter((row) => !row.would_accept).length,
    decisions,
  };
  console.warn(
    `kalshi parlay executor: live=${live ? 1 : 0} attempted=${pass.attempted} would_accept=${pass.would_accept} accepted=${pass.accepted}`,
  );
  return pass;
}
