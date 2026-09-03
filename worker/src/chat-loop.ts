/**
 * Pure Chat agent-loop policy (toolChoice / activeTools).
 *
 * Kept free of Workers-runtime imports so it is unit-testable in plain Node.
 * Chat historically forced `run_query` until one query succeeded; models
 * then burned the whole 10-step budget on bare probes like `SELECT 1` /
 * `SELECT 'test' AS t` (chat c7d67546…, 2026-08-16). After a small number of
 * failures we stop forcing tools so the turn can close in prose.
 *
 * When the user attaches a portfolio, force `get_portfolio` first — lake SQL
 * is not the grounding evidence for brokerage/paper books (share
 * 1pQXi6YlgunqnHl5QCzgfsTgn: forced SELECT 1 ×3, never called get_portfolio).
 */

export const AGENT_ITERATIONS_MAX = 10;

/** Forced run_query attempts before the loop releases the model to answer. */
export const QUERY_FORCE_FAILURES_MAX = 3;

/** Forced get_portfolio attempts before sealing so the model can explain. */
export const PORTFOLIO_FORCE_FAILURES_MAX = 2;

/** Forced suggest_trades attempts before sealing without structured trades. */
export const TRADES_FORCE_FAILURES_MAX = 2;

/** Forced publish_desk attempts before we stop forcing (still allow auto). */
export const DESK_FORCE_FAILURES_MAX = 4;

/**
 * Auto tool rounds after the first successful lake query before we force
 * publish_desk. Without this, models under forced toolChoice emit stub
 * "placeholder" desks before research_ticker / chain SQL land
 * (share ynQcuupDNBG04fcaYleY01hi).
 */
export const AUTO_STEPS_AFTER_QUERY_BEFORE_DESK = 5;

/**
 * After get_portfolio already grounded the book, keep the gather window short.
 * Portfolio risk reviews otherwise research every holding until disconnect
 * (share 23nE1Q9OqTm1noJSWszE0Qj3E: get_portfolio + research ×N, empty content).
 */
export const AUTO_STEPS_AFTER_PORTFOLIO_BEFORE_DESK = 2;

export type ChatToolChoice =
  | "auto"
  | "none"
  | {
    type: "tool";
    toolName:
      | "run_query"
      | "filter_frame"
      | "publish_desk"
      | "suggest_trades"
      | "get_portfolio";
  };

export type ChatActiveToolName =
  | "run_query"
  | "filter_frame"
  | "check_schema"
  | "list_frames"
  | "refresh_frame"
  | "render_chart"
  | "get_news"
  | "web_search"
  | "eco_calendar"
  | "research_ticker"
  | "lookup_symbols"
  | "publish_desk"
  | "suggest_trades"
  | "get_paper_portfolio"
  | "get_portfolio"
  | "get_bot_trades";

export interface ChatStepPolicy {
  toolChoice: ChatToolChoice;
  /** When set, restricts which tools the model may call this step. */
  activeTools?: ChatActiveToolName[];
  maxOutputTokens: number;
}

export function nextChatStepPolicy(opts: {
  stepNumber: number;
  remainingTokens: number;
  successfulQuery: boolean;
  failedQueryCount: number;
  preferFilterFrame: boolean;
  toolRoundTokensMax: number;
  finalTokenReserve: number;
  maxSteps?: number;
  forceFailuresMax?: number;
  /**
   * User attached a portfolio this turn — load it before forcing lake SQL.
   * Cleared once portfolioLoaded (or successfulQuery) is true.
   */
  requirePortfolio?: boolean;
  portfolioLoaded?: boolean;
  failedPortfolioCount?: number;
  portfolioForceFailuresMax?: number;
  /** When true, force publish_desk once evidence exists and the desk is not yet published. */
  requireDesk?: boolean;
  deskPublished?: boolean;
  /** Auto steps completed after the first successful query (desk gather window). */
  stepsAfterQuery?: number;
  autoStepsBeforeDesk?: number;
  failedDeskCount?: number;
  deskForceFailuresMax?: number;
  /** When true (with requireDesk), force suggest_trades after the desk before sealing. */
  requireTrades?: boolean;
  tradesPublished?: boolean;
  /** Failed suggest_trades attempts this turn (incomplete payload, etc.). */
  failedTradesCount?: number;
  tradesForceFailuresMax?: number;
}): ChatStepPolicy {
  const maxSteps = opts.maxSteps ?? AGENT_ITERATIONS_MAX;
  const forceFailuresMax = opts.forceFailuresMax ?? QUERY_FORCE_FAILURES_MAX;
  const portfolioForceFailuresMax = opts.portfolioForceFailuresMax ?? PORTFOLIO_FORCE_FAILURES_MAX;
  const tradesForceFailuresMax = opts.tradesForceFailuresMax ?? TRADES_FORCE_FAILURES_MAX;
  const deskForceFailuresMax = opts.deskForceFailuresMax ?? DESK_FORCE_FAILURES_MAX;
  const autoBeforeDesk = opts.autoStepsBeforeDesk ?? AUTO_STEPS_AFTER_QUERY_BEFORE_DESK;
  const remaining = opts.remainingTokens;
  if (remaining < 256) {
    throw new Error("Chat output-token budget exhausted before a final answer");
  }

  // Last step: always seal a prose answer (no tools).
  if (opts.stepNumber >= maxSteps - 1) {
    return { toolChoice: "none", activeTools: [], maxOutputTokens: remaining };
  }

  const toolBudget = Math.max(256, Math.min(opts.toolRoundTokensMax, remaining - opts.finalTokenReserve));
  // Portfolio load counts as grounding evidence (same post-evidence desk path).
  const hasEvidence = opts.successfulQuery || Boolean(opts.portfolioLoaded);

  if (hasEvidence) {
    // Callers that opt out of the desk (legacy bot path) keep interleaved
    // text + tools for a visible takeaway. Do not hard-seal on chart alone —
    // that left "(see reasoning)" shares on prod after #210 (DeepSeek dumps
    // the close into the reasoning channel under toolChoice:none). Keep auto
    // until the penultimate step; DSML strip + quality-gate heuristics catch
    // markup leaks.
    if (!opts.requireDesk) {
      if (opts.stepNumber >= maxSteps - 2) {
        return { toolChoice: "none", activeTools: [], maxOutputTokens: remaining };
      }
      return { toolChoice: "auto", maxOutputTokens: toolBudget };
    }
    // After lake evidence lands, force the routed multi-analyst desk once so the UI
    // gets the active specialist panels (not TA-only prose).
    // Give a short auto window first so research_ticker / chain SQL can run —
    // forcing desk on the next step produced literal "placeholder" stubs.
    if (opts.requireDesk && !opts.deskPublished) {
      const stepsAfterQuery = opts.stepsAfterQuery ?? 0;
      // Reserve final steps for suggest_trades + prose.
      const mustSealSoon = opts.stepNumber >= maxSteps - 2;
      if (mustSealSoon) {
        return { toolChoice: "none", activeTools: [], maxOutputTokens: remaining };
      }
      const nearEnd = opts.stepNumber >= maxSteps - 4;
      const gatherDone = stepsAfterQuery >= autoBeforeDesk || nearEnd;
      const failedDesk = opts.failedDeskCount ?? 0;
      if (!gatherDone) {
        return { toolChoice: "auto", maxOutputTokens: toolBudget };
      }
      // After a stub rejection, give one auto step so the model can dig more
      // evidence instead of immediately re-emitting "placeholder".
      if (failedDesk > 0 && failedDesk % 2 === 1 && failedDesk < deskForceFailuresMax) {
        return { toolChoice: "auto", maxOutputTokens: toolBudget };
      }
      if (failedDesk < deskForceFailuresMax) {
        const deskBudget = Math.max(toolBudget, Math.min(4_096, remaining - opts.finalTokenReserve));
        return {
          maxOutputTokens: Math.max(256, deskBudget),
          toolChoice: { type: "tool", toolName: "publish_desk" },
        };
      }
      // Exhausted desk retries — leave tools on auto so a voluntary real desk
      // can still land; do not hard-seal empty (that produced "no written answer").
      return { toolChoice: "auto", maxOutputTokens: toolBudget };
    }
    // Structured trades next — UI renders from suggest_trades, not prose parsing.
    // Stop forcing after repeated incomplete payloads so the turn can seal.
    const failedTrades = opts.failedTradesCount ?? 0;
    if (
      opts.requireDesk
      && opts.deskPublished
      && opts.requireTrades
      && !opts.tradesPublished
      && failedTrades < tradesForceFailuresMax
    ) {
      return {
        maxOutputTokens: toolBudget,
        toolChoice: { type: "tool", toolName: "suggest_trades" },
      };
    }
    // Interactive chat: desk + trades is the answer — seal so extra tool
    // rounds cannot leave mid-turn narration as the visible text.
    if (opts.requireDesk && opts.deskPublished && opts.requireTrades) {
      return { toolChoice: "none", activeTools: [], maxOutputTokens: remaining };
    }
    // Timeline bots: desk is published, trades not required. Keep auto so
    // render_chart can still run, then seal on the penultimate step (same
    // takeaway-in-text fix as the no-desk path above).
    if (opts.requireDesk && opts.deskPublished) {
      if (opts.stepNumber >= maxSteps - 2) {
        return { toolChoice: "none", activeTools: [], maxOutputTokens: remaining };
      }
      return { toolChoice: "auto", maxOutputTokens: toolBudget };
    }
    return { toolChoice: "auto", maxOutputTokens: toolBudget };
  }

  // Attached portfolio: load the book before any lake SQL force. Without this,
  // portfolio questions burn QUERY_FORCE_FAILURES_MAX on SELECT 1 and never
  // call get_portfolio.
  if (opts.requirePortfolio && !opts.portfolioLoaded) {
    const failedPortfolio = opts.failedPortfolioCount ?? 0;
    if (failedPortfolio >= portfolioForceFailuresMax) {
      return { toolChoice: "none", activeTools: [], maxOutputTokens: remaining };
    }
    return {
      maxOutputTokens: toolBudget,
      toolChoice: { type: "tool", toolName: "get_portfolio" },
    };
  }

  // After repeated SQL failures, stop forcing tools so the model cannot
  // spin on the same rejected probe for the rest of the turn.
  if (opts.failedQueryCount >= forceFailuresMax) {
    return { toolChoice: "none", activeTools: [], maxOutputTokens: remaining };
  }

  return {
    maxOutputTokens: toolBudget,
    toolChoice: {
      type: "tool",
      toolName: opts.preferFilterFrame && opts.stepNumber === 0 ? "filter_frame" : "run_query",
    },
  };
}
