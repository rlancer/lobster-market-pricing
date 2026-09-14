/**
 * Kalshi same-game parlay executor.
 *
 * Separate from kalshi-markets-hourly / the RFQ research probe:
 *   1. Fetch every open sports MVE from Get Markets (no lake volume-80
 *      cap) plus selected-leg snapshots only for same-game two-leg stacks.
 *      No candle backfill, no research RFQ overlay. Same-game grouping
 *      uses mve_selected_legs.event_ticker, not category.
 *   2. Rank same-game two-leg sports stacks by corr room.
 *   3. Create an RFQ, wait for a private two-way, score it.
 *   4. Default: log would_accept and DELETE the RFQ.
 *   5. Live fill: PUT .../quotes/{id}/accept { accepted_side: "yes" } only when
 *      KALSHI_PARLAY_EXECUTE=1 AND KALSHI_PARLAY_LIVE=1. Size is
 *      KALSHI_RFQ_CONTRACTS (default 10 = $10 notional). At most
 *      KALSHI_PARLAY_MAX_ACCEPTS_PER_PASS (default 1) fills per pass. The
 *      maker confirms (HVM 3s). This module never calls /confirm.
 *
 * Do not ingest the full sports catalog. Chat suggest_trades stays investing-only.
 */

import type { KalshiEnv, KalshiMarketRow } from "./kalshi.js";
import {
  DEFAULT_KALSHI_API_BASE,
  fetchKalshiParlayExecutorPack,
  kalshiAuthConfigured,
  kalshiRequest,
} from "./kalshi.js";
import type { MveSelectedLeg } from "./kalshi-mve.js";
import {
  evaluateParlayQuote,
  parlayExecuteEnabled,
  parlayLiveEnabled,
  parlayMaxAcceptsPerPass,
  type ParlayQuoteDecision,
} from "./kalshi-parlay-filter.js";
import {
  cancelKalshiRfq,
  pickRfqProbeTargets,
  rfqContracts,
  rfqProbeMax,
  rfqProbeUniverseStats,
  solicitRfqTwoWay,
  type RfqProbeTarget,
  type RfqProbeUniverseStats,
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

export type ParlayIdleReason =
  | "execute_off"
  | "no_api_keys"
  | "no_targets"
  | "forbidden"
  | null;

export interface ParlayExecutorPass extends RfqProbeUniverseStats {
  attempted: number;
  would_accept: number;
  accepted: number;
  skipped: number;
  decisions: ParlayExecutorDecision[];
  idle_reason: ParlayIdleReason;
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
    console.warn(`kalshi parlay executor: skip ${target.market_ticker} reasons=forbidden`);
    return base;
  }
  try {
    if (!solicited.twoWay) {
      base.error = "no_two_way";
      console.warn(`kalshi parlay executor: skip ${target.market_ticker} reasons=no_two_way`);
      return base;
    }
    base.yes_bid = solicited.twoWay.yes_bid;
    base.yes_ask = solicited.twoWay.yes_ask;
    base.quote_id = solicited.twoWay.quote_id;
    const filter = decisionFromTwoWay(target, legs, solicited.twoWay);
    base.filter = filter;
    base.would_accept = filter.ok;
    if (!filter.ok) {
      console.warn(
        `kalshi parlay executor: skip ${target.market_ticker} reasons=${filter.reasons.join(",")}`,
      );
      return base;
    }
    if (!live) {
      console.warn(
        `kalshi parlay executor: would_accept ${target.market_ticker} ask=${solicited.twoWay.yes_ask.toFixed(3)} indep=${filter.independence.toFixed(3)} room=${filter.corr_room.toFixed(3)}`,
      );
      return base;
    }
    if (!solicited.rfqId || !solicited.twoWay.quote_id) {
      base.error = "no_quote_id";
      console.warn(`kalshi parlay executor: skip ${target.market_ticker} reasons=no_quote_id`);
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
    if (solicited.rfqId && !base.accepted) {
      await cancelKalshiRfq(env, solicited.rfqId);
      console.warn(`kalshi parlay executor: deleted rfq ${solicited.rfqId} ${target.market_ticker}`);
    }
  }
}

export function emptyParlayPass(
  idle_reason: ParlayIdleReason = null,
  universe: Partial<RfqProbeUniverseStats> = {},
): ParlayExecutorPass {
  return {
    attempted: 0,
    would_accept: 0,
    accepted: 0,
    skipped: 0,
    decisions: [],
    idle_reason,
    open_combos: universe.open_combos ?? 0,
    open_legs: universe.open_legs ?? 0,
    combo_legs: universe.combo_legs ?? 0,
    two_leg: universe.two_leg ?? 0,
    same_game_two_leg: universe.same_game_two_leg ?? 0,
    cross_game_two_leg: universe.cross_game_two_leg ?? 0,
    missing_leg_mids: universe.missing_leg_mids ?? 0,
    samples: universe.samples ?? [],
  };
}

export function parlayExecutorPassDetail(
  pass: ParlayExecutorPass,
  flags: { execute: boolean; live: boolean; contracts: number; max_accepts_per_pass: number },
): Record<string, unknown> {
  return {
    execute: flags.execute,
    live: flags.live,
    contracts: flags.contracts,
    max_accepts_per_pass: flags.max_accepts_per_pass,
    idle_reason: pass.idle_reason,
    open_combos: pass.open_combos,
    open_legs: pass.open_legs,
    combo_legs: pass.combo_legs,
    two_leg: pass.two_leg,
    same_game_two_leg: pass.same_game_two_leg,
    cross_game_two_leg: pass.cross_game_two_leg,
    missing_leg_mids: pass.missing_leg_mids,
    samples: pass.samples.slice(0, 5),
    attempted: pass.attempted,
    would_accept: pass.would_accept,
    accepted: pass.accepted,
    skipped: pass.skipped,
    decisions: pass.decisions.slice(0, 20).map((row) => ({
      market_ticker: row.market_ticker,
      would_accept: row.would_accept,
      accepted: row.accepted,
      reasons: row.filter?.reasons ?? [],
      error: row.error,
      yes_bid: row.yes_bid,
      yes_ask: row.yes_ask,
      rfq_id: row.rfq_id,
      quote_id: row.quote_id,
    })),
  };
}

/**
 * One executor pass. No-ops unless KALSHI_PARLAY_EXECUTE=1.
 * Accepts only when KALSHI_PARLAY_LIVE=1 as well.
 */
export async function runKalshiParlayExecutorPass(
  env: KalshiEnv = {},
): Promise<ParlayExecutorPass> {
  if (!parlayExecuteEnabled(env)) return emptyParlayPass("execute_off");
  if (!kalshiAuthConfigured(env)) {
    console.warn("kalshi parlay executor: skipped (no API keys)");
    return emptyParlayPass("no_api_keys");
  }

  const live = parlayLiveEnabled(env);
  const maxAccepts = parlayMaxAcceptsPerPass(env);
  const pack = await fetchKalshiParlayExecutorPack(env);
  const { combos, legs } = splitOpenSportsRows(pack.rows);
  const comboLegs = pack.comboLegs;
  const universe = rfqProbeUniverseStats(combos, comboLegs, legs);
  const targets = pickRfqProbeTargets(combos, comboLegs, legs, rfqProbeMax(env));
  if (targets.length === 0) {
    console.warn(
      `kalshi parlay executor: skip no_targets open_combos=${universe.open_combos} open_legs=${universe.open_legs} combo_legs=${universe.combo_legs} two_leg=${universe.two_leg} same_game_two_leg=${universe.same_game_two_leg} cross_game_two_leg=${universe.cross_game_two_leg} missing_leg_mids=${universe.missing_leg_mids}`,
    );
    return emptyParlayPass("no_targets", universe);
  }

  const cleanup = await cancelOwnOpenRfqs(env);
  if (cleanup === "forbidden") {
    console.warn("kalshi parlay executor: skipped communications 401/403 (need write::trade)");
    return emptyParlayPass("forbidden", universe);
  }

  const decisions: ParlayExecutorDecision[] = [];
  let acceptedCount = 0;
  for (const target of targets) {
    if (live && acceptedCount >= maxAccepts) break;
    const decision = await executeOne(env, target, comboLegs.get(target.market_ticker), live);
    decisions.push(decision);
    if (decision.accepted) acceptedCount += 1;
    if (decision.error === "forbidden") break;
  }

  const pass: ParlayExecutorPass = {
    attempted: decisions.length,
    would_accept: decisions.filter((row) => row.would_accept).length,
    accepted: decisions.filter((row) => row.accepted).length,
    skipped: decisions.filter((row) => !row.would_accept).length,
    decisions,
    idle_reason: null,
    ...universe,
  };
  console.warn(
    `kalshi parlay executor: live=${live ? 1 : 0} contracts=${rfqContracts(env)} max_accepts=${maxAccepts} attempted=${pass.attempted} would_accept=${pass.would_accept} accepted=${pass.accepted}`,
  );
  return pass;
}
