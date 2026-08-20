/**
 * Pure Copilot agent-loop policy (toolChoice / activeTools).
 *
 * Kept free of Workers-runtime imports so it is unit-testable in plain Node.
 * Copilot historically forced `run_query` until one query succeeded; models
 * then burned the whole 10-step budget on bare probes like `SELECT 1` /
 * `SELECT 'test' AS t` (chat c7d67546…, 2026-08-16). After a small number of
 * failures we stop forcing tools so the turn can close in prose.
 */

export const AGENT_ITERATIONS_MAX = 10;

/** Forced run_query attempts before the loop releases the model to answer. */
export const QUERY_FORCE_FAILURES_MAX = 3;

/** Forced suggest_trades attempts before sealing without structured trades. */
export const TRADES_FORCE_FAILURES_MAX = 2;

/** Forced publish_desk attempts before sealing without a desk. */
export const DESK_FORCE_FAILURES_MAX = 2;

/**
 * Auto tool rounds after the first successful lake query before we force
 * publish_desk. Without this, models under forced toolChoice emit stub
 * "placeholder" desks before research_ticker / chain SQL land
 * (share ynQcuupDNBG04fcaYleY01hi).
 */
export const AUTO_STEPS_AFTER_QUERY_BEFORE_DESK = 3;

export type CopilotToolChoice =
  | "auto"
  | "none"
  | { type: "tool"; toolName: "run_query" | "filter_frame" | "publish_desk" | "suggest_trades" };

export type CopilotActiveToolName =
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
  | "publish_desk"
  | "suggest_trades";

export interface CopilotStepPolicy {
  toolChoice: CopilotToolChoice;
  /** When set, restricts which tools the model may call this step. */
  activeTools?: CopilotActiveToolName[];
  maxOutputTokens: number;
}

export function nextCopilotStepPolicy(opts: {
  stepNumber: number;
  remainingTokens: number;
  successfulQuery: boolean;
  failedQueryCount: number;
  preferFilterFrame: boolean;
  toolRoundTokensMax: number;
  finalTokenReserve: number;
  maxSteps?: number;
  forceFailuresMax?: number;
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
}): CopilotStepPolicy {
  const maxSteps = opts.maxSteps ?? AGENT_ITERATIONS_MAX;
  const forceFailuresMax = opts.forceFailuresMax ?? QUERY_FORCE_FAILURES_MAX;
  const tradesForceFailuresMax = opts.tradesForceFailuresMax ?? TRADES_FORCE_FAILURES_MAX;
  const deskForceFailuresMax = opts.deskForceFailuresMax ?? DESK_FORCE_FAILURES_MAX;
  const autoBeforeDesk = opts.autoStepsBeforeDesk ?? AUTO_STEPS_AFTER_QUERY_BEFORE_DESK;
  const remaining = opts.remainingTokens;
  if (remaining < 256) {
    throw new Error("Copilot output-token budget exhausted before a final answer");
  }

  // Last step: always seal a prose answer (no tools).
  if (opts.stepNumber >= maxSteps - 1) {
    return { toolChoice: "none", activeTools: [], maxOutputTokens: remaining };
  }

  const toolBudget = Math.max(256, Math.min(opts.toolRoundTokensMax, remaining - opts.finalTokenReserve));

  if (opts.successfulQuery) {
    // After lake evidence lands, force the three-analyst desk once so the UI
    // always gets Fundamental / Technical / Options panels (not TA-only prose).
    // Give a short auto window first so research_ticker / chain SQL can run —
    // forcing desk on the next step produced literal "placeholder" stubs.
    if (opts.requireDesk && !opts.deskPublished) {
      const stepsAfterQuery = opts.stepsAfterQuery ?? 0;
      const nearEnd = opts.stepNumber >= maxSteps - 3;
      const gatherDone = stepsAfterQuery >= autoBeforeDesk || nearEnd;
      const failedDesk = opts.failedDeskCount ?? 0;
      if (!gatherDone) {
        return { toolChoice: "auto", maxOutputTokens: toolBudget };
      }
      if (failedDesk < deskForceFailuresMax) {
        const deskBudget = Math.max(toolBudget, Math.min(4_096, remaining - opts.finalTokenReserve));
        return {
          maxOutputTokens: Math.max(256, deskBudget),
          toolChoice: { type: "tool", toolName: "publish_desk" },
        };
      }
      // Stub/incomplete desk exhausted retries — seal so the turn does not spin.
      return { toolChoice: "none", activeTools: [], maxOutputTokens: remaining };
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
    // Desk (+ trades when required) is the answer — seal with prose only. Extra
    // tool rounds after publish_desk widen the abort window and leave mid-turn
    // narration as the visible text when the final tool parts never land.
    if (opts.requireDesk && opts.deskPublished) {
      return { toolChoice: "none", activeTools: [], maxOutputTokens: remaining };
    }
    return { toolChoice: "auto", maxOutputTokens: toolBudget };
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
