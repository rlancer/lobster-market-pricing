/**
 * Multi-analyst desk: three specialists share the same lake evidence, then a
 * weighed overview. Structured via the publish_desk tool so the UI can show
 * each viewpoint without parsing freeform markdown.
 */

export const DESK_VIEWPOINT_IDS = ["fundamental", "technical", "options"] as const;
export type DeskViewpointId = (typeof DESK_VIEWPOINT_IDS)[number];

export interface DeskViewpoint {
  id: DeskViewpointId;
  label: string;
  body: string;
}

export interface DeskBrief {
  fundamental: string;
  technical: string;
  options: string;
  overview: string;
}

export const DESK_VIEWPOINT_LABELS: Record<DeskViewpointId, string> = {
  fundamental: "Fundamental",
  technical: "Technical",
  options: "Options",
};

/** Specialist briefs shown in admin Copilot explore. */
export const DESK_SPECIALIST_SUMMARIES: Record<DeskViewpointId, string> = {
  fundamental:
    "Business quality, earnings catalysts, filings, sector/peer context, and lake fundamentals — not chart patterns.",
  technical:
    "Price/volume structure, trend, consolidation/accumulation, realized vol, and levels — one of three voices, never the whole desk.",
  options:
    "IV/skew, liquidity, DTE, and tradable defined-risk structures grounded in option_contracts quotes.",
};

export const DESK_OVERVIEW_SUMMARY =
  "Weighs agreement and disagreement across the three specialists; states the net take and any tradable lean without burying fundamental or options context under technicals.";

const VIEWPOINT_MAX_CHARS = 2_400;
const OVERVIEW_MAX_CHARS = 3_200;

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** Normalize / bound a publish_desk payload for tool output + UI. */
export function normalizeDeskBrief(input: {
  fundamental: string;
  technical: string;
  options: string;
  overview: string;
}): DeskBrief | null {
  const fundamental = clip(String(input.fundamental ?? ""), VIEWPOINT_MAX_CHARS);
  const technical = clip(String(input.technical ?? ""), VIEWPOINT_MAX_CHARS);
  const options = clip(String(input.options ?? ""), VIEWPOINT_MAX_CHARS);
  const overview = clip(String(input.overview ?? ""), OVERVIEW_MAX_CHARS);
  if (!fundamental || !technical || !options || !overview) return null;
  return { fundamental, technical, options, overview };
}

export function deskViewpointsFromBrief(brief: DeskBrief): DeskViewpoint[] {
  return DESK_VIEWPOINT_IDS.map((id) => ({
    id,
    label: DESK_VIEWPOINT_LABELS[id],
    body: brief[id],
  }));
}

export function formatDeskToolSummary(brief: DeskBrief): string {
  return [
    "Desk viewpoints published:",
    `Fundamental — ${brief.fundamental.slice(0, 120)}${brief.fundamental.length > 120 ? "…" : ""}`,
    `Technical — ${brief.technical.slice(0, 120)}${brief.technical.length > 120 ? "…" : ""}`,
    `Options — ${brief.options.slice(0, 120)}${brief.options.length > 120 ? "…" : ""}`,
    `Overview — ${brief.overview.slice(0, 160)}${brief.overview.length > 160 ? "…" : ""}`,
  ].join("\n");
}

/** Prompt block describing the three specialists + overview (shared by system prompt + admin). */
export function deskAnalystBlock(): string {
  return [
    "You channel a three-analyst trading desk. All three specialists share the same tool evidence (SQL frames, research_ticker, news, calendar) — they must not invent separate facts.",
    "",
    "Specialists (equal weight — do not default to technicals):",
    `- Fundamental analyst: ${DESK_SPECIALIST_SUMMARIES.fundamental}`,
    `- Technical analyst: ${DESK_SPECIALIST_SUMMARIES.technical}`,
    `- Options trader: ${DESK_SPECIALIST_SUMMARIES.options}`,
    `- Desk overview: ${DESK_OVERVIEW_SUMMARY}`,
    "",
    "Desk publishing:",
    "- For ticker deep-dives, trade ideas, why-is-it-moving, and other market analysis, MUST call publish_desk after tools and before the final prose. Fill all four fields with distinct angles grounded in the shared evidence.",
    "- Keep each specialist take to roughly 2–5 sentences. The overview weighs where they agree or conflict and states the net take.",
    "- The final message text should be the desk overview (or a short pointer to it). Do not re-paste the three specialist takes into the prose — the UI already shows them from publish_desk.",
    "- Skip publish_desk only for pure schema/SQL mechanics, bare calendar lists, or off-analysis tool housekeeping.",
    "- Never overweight technical analysis: if price action is loud but fundamentals or options liquidity disagree, say so in the overview.",
  ].join("\n");
}
