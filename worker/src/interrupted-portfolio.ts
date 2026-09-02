/**
 * Detect a sealed-but-unfinished assistant turn that already loaded a portfolio.
 *
 * Share 23nE1Q9OqTm1noJSWszE0Qj3E: get_portfolio succeeded, then research burned
 * the gather window and disconnect sealed empty content. On a finish follow-up,
 * seed portfolioLoaded so the loop forces publish_desk instead of re-researching.
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

/** True when the last assistant before the latest user turn loaded a book and never wrote prose. */
export function interruptedPortfolioGrounding(messages: readonly { role?: unknown; parts?: unknown }[]): boolean {
  if (!Array.isArray(messages) || messages.length < 2) return false;

  let lastAssistant: { parts: UiPart[] } | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    if (role === "user") {
      // Skip the trailing user turn(s) that triggered this request.
      if (lastAssistant) break;
      continue;
    }
    if (role === "assistant") {
      const parts = Array.isArray((message as { parts?: unknown }).parts)
        ? ((message as { parts: UiPart[] }).parts)
        : [];
      lastAssistant = { parts };
      break;
    }
  }
  if (!lastAssistant) return false;
  if (assistantText(lastAssistant.parts)) return false;

  return lastAssistant.parts.some((part) => {
    const name = partToolName(part);
    if (name !== "get_portfolio" && name !== "get_paper_portfolio") return false;
    return toolOutputOk(part.output);
  });
}
