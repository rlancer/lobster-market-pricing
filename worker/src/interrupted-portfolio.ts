/**
 * Detect a sealed-but-unfinished assistant turn that already loaded a portfolio.
 *
 * Share 23nE1Q9OqTm1noJSWszE0Qj3E: get_portfolio succeeded, then research burned
 * the gather window and disconnect sealed empty content.
 *
 * Share 1Wqv4alqoqTeNBPoj7fjOnfvd: finish follow-up forced publish_desk on step 0
 * (stub rejection), then a second finish re-fetched the book because grounding
 * only looked at the immediate prior assistant (failed desk, no get_portfolio).
 */

type UiPart = {
  type?: unknown;
  text?: unknown;
  toolName?: unknown;
  state?: unknown;
  output?: unknown;
  input?: unknown;
};

function partToolName(part: UiPart): string {
  if (typeof part.toolName === "string" && part.toolName.trim()) return part.toolName.trim();
  if (typeof part.type !== "string") return "";
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return "";
}

function assistantText(parts: readonly UiPart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("")
    .trim();
}

function toolOutputOk(output: unknown): boolean {
  if (output == null) return false;
  if (typeof output !== "object" || Array.isArray(output)) return true;
  const rec = output as { ok?: unknown };
  return rec.ok !== false;
}

function messageParts(message: { parts?: unknown }): UiPart[] {
  return Array.isArray(message.parts) ? (message.parts as UiPart[]) : [];
}

function hasSuccessfulPortfolioLoad(parts: readonly UiPart[]): boolean {
  return parts.some((part) => {
    const name = partToolName(part);
    if (name !== "get_portfolio" && name !== "get_paper_portfolio") return false;
    return toolOutputOk(part.output);
  });
}

/**
 * True when the latest assistant is empty of prose and some earlier assistant
 * in this chat already loaded a private book — so a finish follow-up can skip
 * re-fetch / re-research and move to publish_desk after one compose step.
 */
export function interruptedPortfolioGrounding(messages: readonly { role?: unknown; parts?: unknown }[]): boolean {
  if (!Array.isArray(messages) || messages.length < 2) return false;

  // Skip trailing user turn(s) that triggered this request.
  let end = messages.length - 1;
  while (end >= 0) {
    const message = messages[end];
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "user") {
      end -= 1;
      continue;
    }
    break;
  }
  if (end < 0) return false;

  const latest = messages[end];
  if (!latest || typeof latest !== "object" || (latest as { role?: unknown }).role !== "assistant") {
    return false;
  }
  if (assistantText(messageParts(latest as { parts?: unknown }))) return false;

  for (let i = 0; i <= end; i++) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    if (hasSuccessfulPortfolioLoad(messageParts(message as { parts?: unknown }))) return true;
  }
  return false;
}

/**
 * How many post-evidence auto steps to seed on a finish follow-up.
 * Leave one slot before AUTO_STEPS_AFTER_PORTFOLIO_BEFORE_DESK so step 0 is
 * auto (compose real desk takes) — forcing publish_desk on step 0 yields stubs
 * (share 1Wqv4alqoqTeNBPoj7fjOnfvd).
 */
export function finishPortfolioStepsAfterQuerySeed(autoStepsBeforeDesk: number): number {
  return Math.max(0, autoStepsBeforeDesk - 1);
}
