/**
 * Kalshi sports parlay executor.
 *
 * Separate from kalshi-markets-hourly / the RFQ research probe:
 *   1. Fetch every open sports MVE from Get Markets (no lake volume-80
 *      cap) plus selected-leg snapshots for the active book's two-leg
 *      stacks (same-game, or cross-game on `cross_game_longshot`).
 *      No candle backfill, no research RFQ overlay. Game grouping
 *      uses mve_selected_legs.event_ticker, not category.
 *   2. Rank those stacks (longshot/underdog: cheapest independence;
 *      corr-room book: Fréchet room).
 *   3. Create an RFQ, wait for a private two-way, score it.
 *   4. Default: log would_accept and DELETE the RFQ.
 *   5. Live fill: PUT .../quotes/{id}/accept { accepted_side: "yes" } only when
 *      KALSHI_PARLAY_EXECUTE=1 AND KALSHI_PARLAY_LIVE=1. Size is
 *      KALSHI_RFQ_CONTRACTS (default 5 = $5 notional). At most
 *      KALSHI_PARLAY_MAX_ACCEPTS_PER_PASS (default 1) fills per pass, and
 *      cumulative cash debit is capped at KALSHI_PARLAY_MAX_SPEND (default
 *      $100) for KALSHI_PARLAY_SPEND_RUN_ID. The maker confirms (HVM 3s).
 *      This module never calls /confirm.
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
import { isCrossGameSportsTwoLeg, isSameGameSportsTwoLeg } from "./kalshi-mve.js";
import {
  annotateParlayConsidered,
  listSameGameConsidered,
  type ParlayConsidered,
} from "./kalshi-parlay-considered.js";
import {
  evaluateParlayExecutorQuote,
  PARLAY_BOOK_LONGSHOT,
  parlayBook,
  parlayExecuteEnabled,
  parlayLiveEnabled,
  parlayMaxAcceptsPerPass,
  type ParlayBookId,
  type ParlayQuoteDecision,
} from "./kalshi-parlay-filter.js";
import {
  canAffordParlay,
  emptyParlaySpendBudget,
  loadParlaySpendBudget,
  parlayMaxSpend,
  parlaySpendRunId,
  quoteYesDebit,
  type ParlaySpendBudget,
} from "./kalshi-parlay-spend.js";
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
  | "max_spend"
  | null;

export interface ParlayExecutorPass extends RfqProbeUniverseStats {
  attempted: number;
  would_accept: number;
  accepted: number;
  skipped: number;
  decisions: ParlayExecutorDecision[];
  considered: ParlayConsidered[];
  idle_reason: ParlayIdleReason;
  book: ParlayBookId;
  max_spend: number;
  spent: number;
  spend_remaining: number;
  spend_since: string | null;
  spend_run_id: string;
  spend_error: string | null;
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
  book: ParlayBookId = parlayBook({}),
): ParlayQuoteDecision {
  const sides = (legs ?? []).map((leg) => leg.side);
  return evaluateParlayExecutorQuote({
    market_ticker: target.market_ticker,
    same_game: isSameGameSportsTwoLeg(legs ?? []),
    cross_game: isCrossGameSportsTwoLeg(legs ?? []),
    sides,
    p: target.p,
    q: target.q,
    yes_bid: twoWay.yes_bid,
    yes_ask: twoWay.yes_ask,
    quote_id: twoWay.quote_id,
  }, book);
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
  book: ParlayBookId,
  spend: { canAccept: boolean; spent: number; maxSpend: number; contracts: number; block?: "max_spend" | "spend_unknown" | null },
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
    const filter = decisionFromTwoWay(target, legs, solicited.twoWay, book);
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
        `kalshi parlay executor: would_accept ${target.market_ticker} ask=${solicited.twoWay.yes_ask.toFixed(3)} payout=${filter.payout_multiple.toFixed(1)}x indep=${filter.independence.toFixed(3)} room=${filter.corr_room.toFixed(3)}`,
      );
      return base;
    }
    if (!spend.canAccept || spend.block) {
      base.error = spend.block ?? "spend_unknown";
      console.warn(
        `kalshi parlay executor: skip ${target.market_ticker} reasons=${base.error}`,
      );
      return base;
    }
    const nextDebit = quoteYesDebit(solicited.twoWay.yes_ask, spend.contracts);
    if (!canAffordParlay(spend.spent, nextDebit, spend.maxSpend)) {
      base.error = "max_spend";
      console.warn(
        `kalshi parlay executor: skip ${target.market_ticker} reasons=max_spend spent=${spend.spent.toFixed(2)} next=${nextDebit.toFixed(2)} cap=${spend.maxSpend}`,
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
  universe: Partial<RfqProbeUniverseStats> & {
    considered?: ParlayConsidered[];
    book?: ParlayBookId;
    max_spend?: number;
    spent?: number;
    spend_remaining?: number;
    spend_since?: string | null;
    spend_run_id?: string;
    spend_error?: string | null;
  } = {},
): ParlayExecutorPass {
  const max_spend = universe.max_spend ?? 0;
  const spent = universe.spent ?? 0;
  return {
    attempted: 0,
    would_accept: 0,
    accepted: 0,
    skipped: 0,
    decisions: [],
    considered: universe.considered ?? [],
    idle_reason,
    open_combos: universe.open_combos ?? 0,
    open_legs: universe.open_legs ?? 0,
    combo_legs: universe.combo_legs ?? 0,
    two_leg: universe.two_leg ?? 0,
    same_game_two_leg: universe.same_game_two_leg ?? 0,
    cross_game_two_leg: universe.cross_game_two_leg ?? 0,
    missing_leg_mids: universe.missing_leg_mids ?? 0,
    samples: universe.samples ?? [],
    book: universe.book ?? parlayBook({}),
    max_spend,
    spent,
    spend_remaining: universe.spend_remaining ?? Math.max(0, max_spend - spent),
    spend_since: universe.spend_since ?? null,
    spend_run_id: universe.spend_run_id ?? parlaySpendRunId({}),
    spend_error: universe.spend_error ?? null,
  };
}

export function parlayExecutorPassDetail(
  pass: ParlayExecutorPass,
  flags: {
    execute: boolean;
    live: boolean;
    contracts: number;
    max_accepts_per_pass: number;
    book?: ParlayBookId;
    max_spend?: number;
    spent?: number;
    spend_remaining?: number;
    spend_since?: string | null;
    spend_run_id?: string;
    spend_error?: string | null;
  },
): Record<string, unknown> {
  return {
    execute: flags.execute,
    live: flags.live,
    contracts: flags.contracts,
    max_accepts_per_pass: flags.max_accepts_per_pass,
    book: flags.book ?? pass.book,
    max_spend: flags.max_spend ?? pass.max_spend,
    spent: flags.spent ?? pass.spent,
    spend_remaining: flags.spend_remaining ?? pass.spend_remaining,
    spend_since: flags.spend_since ?? pass.spend_since,
    spend_run_id: flags.spend_run_id ?? pass.spend_run_id,
    spend_error: flags.spend_error ?? pass.spend_error,
    idle_reason: pass.idle_reason,
    open_combos: pass.open_combos,
    open_legs: pass.open_legs,
    combo_legs: pass.combo_legs,
    two_leg: pass.two_leg,
    same_game_two_leg: pass.same_game_two_leg,
    cross_game_two_leg: pass.cross_game_two_leg,
    missing_leg_mids: pass.missing_leg_mids,
    samples: pass.samples.slice(0, 5),
    considered: pass.considered,
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
      payout_multiple: row.filter?.payout_multiple ?? null,
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
  const book = parlayBook(env);
  const contracts = rfqContracts(env);
  const maxSpend = parlayMaxSpend(env);
  const runId = parlaySpendRunId(env);
  const size = {
    book,
    max_spend: maxSpend,
    spend_run_id: runId,
    spent: 0,
    spend_remaining: maxSpend,
    spend_since: null as string | null,
    spend_error: null as string | null,
  };
  if (!parlayExecuteEnabled(env)) return emptyParlayPass("execute_off", size);
  if (!kalshiAuthConfigured(env)) {
    console.warn("kalshi parlay executor: skipped (no API keys)");
    return emptyParlayPass("no_api_keys", size);
  }

  const live = parlayLiveEnabled(env);
  const maxAccepts = parlayMaxAcceptsPerPass(env);
  let budget: ParlaySpendBudget = emptyParlaySpendBudget(env, live);
  try {
    budget = await loadParlaySpendBudget(env, { live });
  } catch (error) {
    budget = {
      ...emptyParlaySpendBudget(env, live),
      error: error instanceof Error ? error.message : String(error),
      can_accept: false,
    };
  }
  const spendView = {
    book,
    max_spend: budget.max_spend,
    spent: budget.spent,
    spend_remaining: budget.remaining,
    spend_since: budget.since,
    spend_run_id: budget.run_id,
    spend_error: budget.error,
  };
  const rank = book === "corr_room_yes" ? "corr_room" as const : "cheap_independence" as const;
  const universeKind = book === PARLAY_BOOK_LONGSHOT ? "cross_game" as const : "same_game" as const;
  const spendBlock: "max_spend" | "spend_unknown" | null = live && !budget.can_accept
    ? (budget.spent >= budget.max_spend - 1e-12 ? "max_spend" : "spend_unknown")
    : null;

  const pack = await fetchKalshiParlayExecutorPack(env);
  const { combos, legs } = splitOpenSportsRows(pack.rows);
  const comboLegs = pack.comboLegs;
  const universe = rfqProbeUniverseStats(combos, comboLegs, legs, universeKind);
  const consideredBase = listSameGameConsidered(combos, comboLegs, legs, { book });
  const annotate = (
    idle: ParlayIdleReason,
    extra: {
      targetTickers?: Set<string>;
      decisions?: ParlayExecutorDecision[];
      acceptedCount?: number;
    } = {},
  ) => emptyParlayPass(idle, {
    ...universe,
    ...spendView,
    considered: annotateParlayConsidered(consideredBase, {
      targetTickers: extra.targetTickers ?? new Set(),
      decisions: (extra.decisions ?? []).map((row) => ({
        market_ticker: row.market_ticker,
        would_accept: row.would_accept,
        accepted: row.accepted,
        error: row.error,
        reasons: row.filter?.reasons ?? [],
        yes_ask: row.yes_ask,
      })),
      live,
      acceptedCount: extra.acceptedCount ?? 0,
      maxAccepts,
      spendBlocked: extra.decisions?.length ? null : spendBlock,
    }),
  });

  const targets = live && spendBlock === "max_spend"
    ? []
    : pickRfqProbeTargets(combos, comboLegs, legs, rfqProbeMax(env), rank, universeKind);
  const targetTickers = new Set(targets.map((row) => row.market_ticker));

  if (live && spendBlock === "max_spend") {
    console.warn(
      `kalshi parlay executor: skip max_spend spent=${budget.spent.toFixed(2)} cap=${budget.max_spend}`,
    );
    return annotate("max_spend", {
      targetTickers: new Set(consideredBase.filter((row) => !row.skip).map((row) => row.market_ticker)),
    });
  }

  if (targets.length === 0) {
    console.warn(
      `kalshi parlay executor: skip no_targets open_combos=${universe.open_combos} open_legs=${universe.open_legs} combo_legs=${universe.combo_legs} two_leg=${universe.two_leg} same_game_two_leg=${universe.same_game_two_leg} cross_game_two_leg=${universe.cross_game_two_leg} missing_leg_mids=${universe.missing_leg_mids}`,
    );
    return annotate("no_targets", { targetTickers });
  }

  const cleanup = await cancelOwnOpenRfqs(env);
  if (cleanup === "forbidden") {
    console.warn("kalshi parlay executor: skipped communications 401/403 (need write::trade)");
    return annotate("forbidden", { targetTickers });
  }

  const decisions: ParlayExecutorDecision[] = [];
  let acceptedCount = 0;
  let spent = budget.spent;
  const spendState = {
    canAccept: live && budget.can_accept,
    spent,
    maxSpend: budget.max_spend,
    contracts,
    block: spendBlock,
  };
  for (const target of targets) {
    if (live && acceptedCount >= maxAccepts) break;
    if (live && spent >= budget.max_spend - 1e-12) break;
    spendState.spent = spent;
    const decision = await executeOne(
      env,
      target,
      comboLegs.get(target.market_ticker),
      live,
      book,
      spendState,
    );
    decisions.push(decision);
    if (decision.accepted) {
      acceptedCount += 1;
      if (decision.yes_ask != null) spent += quoteYesDebit(decision.yes_ask, contracts);
    }
    if (decision.error === "forbidden") break;
  }

  const considered = annotateParlayConsidered(consideredBase, {
    targetTickers,
    decisions: decisions.map((row) => ({
      market_ticker: row.market_ticker,
      would_accept: row.would_accept,
      accepted: row.accepted,
      error: row.error,
      reasons: row.filter?.reasons ?? [],
      yes_ask: row.yes_ask,
    })),
    live,
    acceptedCount,
    maxAccepts,
    spendBlocked: spendBlock,
  });

  const pass: ParlayExecutorPass = {
    attempted: decisions.length,
    would_accept: decisions.filter((row) => row.would_accept).length,
    accepted: decisions.filter((row) => row.accepted).length,
    skipped: decisions.filter((row) => !row.would_accept).length,
    decisions,
    considered,
    idle_reason: null,
    ...universe,
    book,
    max_spend: budget.max_spend,
    spent,
    spend_remaining: Math.max(0, budget.max_spend - spent),
    spend_since: budget.since,
    spend_run_id: budget.run_id,
    spend_error: budget.error,
  };
  console.warn(
    `kalshi parlay executor: live=${live ? 1 : 0} book=${book} contracts=${contracts} max_accepts=${maxAccepts} spent=${spent.toFixed(2)}/${budget.max_spend} attempted=${pass.attempted} would_accept=${pass.would_accept} accepted=${pass.accepted}`,
  );
  return pass;
}
