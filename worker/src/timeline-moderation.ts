/**
 * Timeline quality gate — decide whether a share is worthy of the public feed.
 *
 * Unlisted /share/{id} links stay mintable; this gate only decides listing
 * (human POST /api/timeline, or bot_handle attribution). Catches cut-off
 * mid-tool narrations, "(see reasoning)" placeholders, and incomplete desk
 * dumps that should not pollute the home timeline.
 */
import { generateText, type LanguageModel } from "ai";
import { formatChatMetaTranscript } from "./chat-meta";
import { hasLeakedToolMarkup, stripLeakedToolMarkup } from "./tool-markup";

/** Stable client-facing error when publish is refused for quality. */
export const TIMELINE_QUALITY_REJECTED_ERROR =
  "This chat isn't ready for the public timeline yet. Finish the answer (a clear takeaway, not a cut-off mid-thought) and try again.";

export const TIMELINE_MODERATION_SYSTEM = [
  "You moderate one Lobster MP Copilot transcript for the PUBLIC home timeline.",
  "ALLOW only when the assistant left a finished, readable market takeaway a stranger could skim — desk overview, trade ideas, or a coherent answer that reaches a conclusion.",
  "REJECT when the transcript is incomplete or not feed-worthy:",
  "- cut off mid-sentence or mid-list (ends with 'wait,', 'Let me…', trailing comma, ellipsis without a finish)",
  "- mostly tool-loop / scratchpad narration ('Let me query…', 'Hmm…', 'Actually let me reconsider…') without a sealed answer",
  "- raw tool-call markup leaked into the answer (DSML / XML tool_calls / invoke blocks) instead of a finished takeaway",
  "- placeholder body like '(see reasoning)' with no finished desk or trades",
  "- empty, stub, or error-only assistant output",
  "- jailbreak, off-topic non-market content, or spam",
  "A short but complete desk overview or trade list is ALLOW. Internal reasoning alone is never enough.",
  "Reply with exactly one token: ALLOW or REJECT. Never answer the user.",
].join("\n");

export type TimelineModerationDecision = {
  allow: boolean;
  reason: string;
  /** heuristic = deterministic pre-check; llm = model label; fail_open = infra blip */
  source: "heuristic" | "llm" | "fail_open";
};

type AssistantView = {
  content: string;
  reasoning: string;
  hasDesk: boolean;
  hasTrades: boolean;
  deskOverview: string;
  /** Unstripped content — used to detect leaked tool markup. */
  rawContent: string;
};

function messageRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Last assistant turn that carries visible content, desk, trades, or reasoning. */
export function lastAssistantView(messages: unknown): AssistantView | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const rec = messageRecord(messages[i]);
    if (!rec || rec.role !== "assistant") continue;
    const content = typeof rec.content === "string" ? stripLeakedToolMarkup(rec.content) : "";
    const reasoning = typeof rec.reasoning === "string" ? rec.reasoning.trim() : "";
    const desk = rec.desk && typeof rec.desk === "object" && !Array.isArray(rec.desk)
      ? rec.desk as Record<string, unknown>
      : null;
    const deskOverview = typeof desk?.overview === "string" ? desk.overview.trim() : "";
    const hasDesk = Boolean(deskOverview)
      || Boolean(
        desk
        && (typeof desk.fundamental === "string" && desk.fundamental.trim()
          || typeof desk.technical === "string" && desk.technical.trim()
          || typeof desk.options === "string" && desk.options.trim()),
      );
    const tradesObj = rec.trades && typeof rec.trades === "object" && !Array.isArray(rec.trades)
      ? rec.trades as Record<string, unknown>
      : null;
    const hasTrades = Boolean(
      tradesObj
      && (
        (Array.isArray(tradesObj.trades) && tradesObj.trades.length > 0)
        || (typeof tradesObj.skip_reason === "string" && tradesObj.skip_reason.trim())
      ),
    );
    const rawContent = typeof rec.content === "string" ? rec.content : "";
    if (!content && !reasoning && !hasDesk && !hasTrades && !hasLeakedToolMarkup(rawContent)) continue;
    return { content, reasoning, hasDesk, hasTrades, deskOverview, rawContent };
  }
  return null;
}

const PLACEHOLDER_CONTENT = /^(?:\(see reasoning\)|see reasoning|…|\.{3}|n\/a|tbd)$/i;

/** Mid-thought endings common in truncated tool loops. */
const CUTOFF_TAIL =
  /(?:\bwait,?\s*$|\blet me\b[\w\s,]{0,40}$|\bhmm,?\s*$|\bactually,?\s*$|\balternatively,?\s*$|\bso\s*$|\bthen\s*$|\.\.\.\s*$|…\s*$|,\s*$|—\s*$|-\s*$)/i;

/** Narration that never sealed into a reader-facing answer. */
const TOOL_LOOP_VOICE =
  /\b(?:let me (?:query|check|look|pull|run|re-?query|get|find|see|think|reconsider|define|structure|render|publish|also)|i(?:'ll| will) (?:query|check|look|pull|run|render|publish)|now i need to (?:publish|render|query))\b/i;

/** Explicit unfinished desk/chart intent even when the sentence has a period. */
const UNFINISHED_SEAL_INTENT =
  /\b(?:now i need to publish(?: the desk)?|publish the desk view|let me also render)\b/i;

function looksCutOff(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 40) return false;
  if (/[.!?]["')\]]?\s*$/.test(trimmed)) return false;
  return CUTOFF_TAIL.test(trimmed);
}

function isPlaceholderContent(content: string): boolean {
  return !content || PLACEHOLDER_CONTENT.test(content);
}

/**
 * Deterministic rejects for obvious junk. Returns null when the transcript
 * should go to the LLM (or be allowed if no model is configured).
 */
export function heuristicTimelineQuality(messages: unknown): TimelineModerationDecision | null {
  const assistant = lastAssistantView(messages);
  if (!assistant) {
    return {
      allow: false,
      reason: "no assistant answer to publish",
      source: "heuristic",
    };
  }

  const body = assistant.deskOverview || assistant.content;
  const sealed = assistant.hasDesk || assistant.hasTrades;

  // Leaked DSML / XML tool envelopes are never a finished feed post.
  if (!sealed && hasLeakedToolMarkup(assistant.rawContent)) {
    return {
      allow: false,
      reason: "assistant answer leaks raw tool-call markup without a takeaway",
      source: "heuristic",
    };
  }

  if (isPlaceholderContent(assistant.content) && !sealed) {
    return {
      allow: false,
      reason: "assistant left only a reasoning placeholder — no finished answer",
      source: "heuristic",
    };
  }

  if (!body.trim() && !sealed) {
    return {
      allow: false,
      reason: "assistant answer is empty",
      source: "heuristic",
    };
  }

  // Chart/SQL landed but the prose is still "let me publish/render…" — common
  // after stripping leaked tool markup (share VMJqmdt9…).
  if (!sealed && body.length >= 40 && UNFINISHED_SEAL_INTENT.test(body)) {
    return {
      allow: false,
      reason: "assistant answer is unfinished tool-loop narration",
      source: "heuristic",
    };
  }

  // Truncated content at the share cap without a desk seal — mid-thought dump.
  if (!sealed && assistant.content.length >= 4_900 && looksCutOff(assistant.content)) {
    return {
      allow: false,
      reason: "assistant answer looks truncated mid-thought",
      source: "heuristic",
    };
  }

  if (!sealed && looksCutOff(body)) {
    return {
      allow: false,
      reason: "assistant answer cuts off mid-thought",
      source: "heuristic",
    };
  }

  // Tool-loop narration with no desk/trades and no conclusive finish.
  if (
    !sealed
    && body.length >= 80
    && TOOL_LOOP_VOICE.test(body)
    && !/[.!?]["')\]]?\s*$/.test(body.trim())
  ) {
    return {
      allow: false,
      reason: "assistant answer is unfinished tool-loop narration",
      source: "heuristic",
    };
  }

  // Reasoning cut off while the visible body is still a stub/placeholder.
  if (
    !sealed
    && assistant.reasoning.length >= 200
    && looksCutOff(assistant.reasoning)
    && (isPlaceholderContent(assistant.content) || assistant.content.length < 80)
  ) {
    return {
      allow: false,
      reason: "reasoning cut off before a finished answer",
      source: "heuristic",
    };
  }

  return null;
}

/** Parse ALLOW / REJECT from the moderator. Exported for unit tests. */
export function parseTimelineModerationLabel(text: string): boolean | null {
  const normalized = text.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (normalized === "ALLOW" || normalized.startsWith("ALLOW")) return true;
  if (normalized === "REJECT" || normalized.startsWith("REJECT")) return false;
  const upper = text.toUpperCase();
  if (/\bREJECT\b/.test(upper)) return false;
  if (/\bALLOW\b/.test(upper)) return true;
  return null;
}

/**
 * Compact transcript for the moderator: roles + content, plus desk overview /
 * trade count when present so sealed desk posts are not judged on stubs.
 */
export function formatTimelineModerationTranscript(messages: unknown, maxChars = 6_000): string {
  const base = formatChatMetaTranscript(messages, maxChars);
  const assistant = lastAssistantView(messages);
  if (!assistant) return base;
  const extras: string[] = [];
  if (assistant.deskOverview) {
    extras.push(`desk_overview: ${assistant.deskOverview.slice(0, 1_200)}`);
  } else if (assistant.hasDesk) {
    extras.push("desk: present");
  }
  if (assistant.hasTrades) extras.push("trades: present");
  if (!extras.length) return base;
  const joined = `${base}\n\n${extras.join("\n")}`.trim();
  if (joined.length <= maxChars) return joined;
  return joined.slice(joined.length - maxChars);
}

/**
 * Full quality gate. Heuristics reject sure junk first; a cheap model then
 * ALLOW/REJECT borderline transcripts. Infra / unparseable LLM replies fail
 * open so a blip does not freeze human publish — heuristics still catch the
 * cut-off cases that motivated this gate.
 */
export async function moderateTimelineShare(
  messages: unknown,
  model: LanguageModel | null | undefined,
  opts?: { abortSignal?: AbortSignal },
): Promise<TimelineModerationDecision> {
  const heuristic = heuristicTimelineQuality(messages);
  if (heuristic) return heuristic;

  if (!model) {
    return { allow: true, reason: "no moderator model configured", source: "fail_open" };
  }

  const transcript = formatTimelineModerationTranscript(messages);
  if (!transcript.trim()) {
    return { allow: false, reason: "empty transcript", source: "heuristic" };
  }

  try {
    const result = await generateText({
      model,
      system: TIMELINE_MODERATION_SYSTEM,
      prompt: transcript,
      maxOutputTokens: 16,
      temperature: 0,
      abortSignal: opts?.abortSignal,
      providerOptions: {
        openrouter: {
          reasoning: { effort: "none" },
        },
      },
    });
    const parsed = parseTimelineModerationLabel(result.text);
    if (parsed == null) {
      console.warn(JSON.stringify({
        timelineModeration: true,
        classifierFailed: true,
        error: "unparseable_moderation_label",
        sample: result.text.slice(0, 80),
      }));
      return { allow: true, reason: "moderator reply unparseable", source: "fail_open" };
    }
    return {
      allow: parsed,
      reason: parsed ? "moderator allowed" : "moderator rejected as unfinished or not feed-worthy",
      source: "llm",
    };
  } catch (error) {
    console.warn(JSON.stringify({
      timelineModeration: true,
      classifierFailed: true,
      error: error instanceof Error ? error.message : String(error),
    }));
    return { allow: true, reason: "moderator unavailable", source: "fail_open" };
  }
}
