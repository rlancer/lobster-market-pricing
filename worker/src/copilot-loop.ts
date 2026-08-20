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

export type CopilotToolChoice =
  | "auto"
  | "none"
  | { type: "tool"; toolName: "run_query" | "filter_frame" };

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
  | "publish_desk";

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
}): CopilotStepPolicy {
  const maxSteps = opts.maxSteps ?? AGENT_ITERATIONS_MAX;
  const forceFailuresMax = opts.forceFailuresMax ?? QUERY_FORCE_FAILURES_MAX;
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
