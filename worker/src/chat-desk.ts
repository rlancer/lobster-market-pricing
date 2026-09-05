/**
 * Multi-analyst desk: selected specialists share the same lake evidence, then a
 * weighed overview. Structured via the publish_desk tool so the UI can show
 * each viewpoint without parsing freeform markdown.
 *
 * Not every turn uses every specialist — see selectDeskSpecialists().
 */

export const DESK_VIEWPOINT_IDS = [
  "fundamental",
  "technical",
  "options",
  "risk",
  "macro",
] as const;
export type DeskViewpointId = (typeof DESK_VIEWPOINT_IDS)[number];

export interface DeskViewpoint {
  id: DeskViewpointId;
  label: string;
  body: string;
}

/** Specialist takes are optional; overview is always required when a desk exists. */
export interface DeskBrief {
  fundamental?: string;
  technical?: string;
  options?: string;
  risk?: string;
  macro?: string;
  overview: string;
}

export type DeskBriefInput = {
  fundamental?: string | null;
  technical?: string | null;
  options?: string | null;
  risk?: string | null;
  macro?: string | null;
  overview?: string | null;
};

export const DESK_VIEWPOINT_LABELS: Record<DeskViewpointId, string> = {
  fundamental: "Fundamental",
  technical: "Technical",
  options: "Options",
  risk: "Risk",
  macro: "Macro",
};

/** Specialist briefs shown in admin Chat explore. */
export const DESK_SPECIALIST_SUMMARIES: Record<DeskViewpointId, string> = {
  fundamental:
    "Business quality, earnings catalysts, filings, sector/peer context, and lake fundamentals — or for spot crypto/indexes, adoption/flow drivers instead of earnings — not chart patterns.",
  technical:
    "Price/volume structure, trend, consolidation/accumulation, realized vol, and levels — one voice among the active desk, never the whole desk. Spot crypto uses BTC-USD (etc.) bars in options.ohlc, not an ETF proxy.",
  options:
    "IV/skew, liquidity, DTE, and tradable defined-risk structures grounded in option_contracts quotes. Spot crypto has no OCC root — say so, then optionally compare via listed crypto ETF options (IBIT, …) or CME futures (BTC=F) when those help the ask.",
  risk:
    "Downside, sizing, liquidity gaps, event/gap risk, and what breaks the thesis — hedges and max-pain framing without restating the options structure play-by-play. Distinguish issuer/single-name concentration from ETF sleeve size (a 25% equal-weight index ETF is beta, not one stock). Use lookup_symbols top holdings and/or options.etf_holdings before naming an issuer inside a fund.",
  macro:
    "Rates, Fed/liquidity, factor/beta regime, USD, and cross-asset context that moves index/ETF beta names (SPY, TLT, …). Skip for single-name options microstructure unless the ask is explicitly macro-driven.",
};

export const DESK_OVERVIEW_SUMMARY =
  "Weighs agreement and disagreement across the active specialists only; states the net take and any tradable lean without burying fundamental, options, risk, or macro context under technicals.";

/** Shared shape for desk takes, overviews, and the closing assistant message. */
export const DESK_MARKDOWN_SHAPE =
  "Write specialist takes, the overview, and the closing message as Markdown: short paragraphs separated by blank lines, **bold** for the lean and key numbers/levels, and bullets for catalysts, levels, or dates. Never one run-on sentence or a single wall of text. No code fences or tables. Optional ### subheads only.";

/** Classic four-analyst core used when no route is supplied (macro stays routed). */
export const DESK_CORE_VIEWPOINT_IDS: DeskViewpointId[] = [
  "fundamental",
  "technical",
  "options",
  "risk",
];

const VIEWPOINT_MAX_CHARS = 2_400;
const OVERVIEW_MAX_CHARS = 3_200;
/** Specialist takes should be real sentences — not "placeholder" stubs. */
const VIEWPOINT_MIN_CHARS = 40;
const OVERVIEW_MIN_CHARS = 40;

/**
 * Bound length without flattening Markdown. Horizontal runs collapse;
 * newlines and blank-line paragraphs stay so the UI can render lists
 * and emphasis. Prefer a paragraph / line / word cut over a mid-token slice.
 */
export function clipDeskMarkdown(text: string, max: number): string {
  const trimmed = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max - 1);
  const para = slice.lastIndexOf("\n\n");
  const line = slice.lastIndexOf("\n");
  const word = slice.lastIndexOf(" ");
  const minKeep = Math.floor(max * 0.55);
  const cut = para >= minKeep ? para : line >= minKeep ? line : word;
  const kept = (cut > 0 ? slice.slice(0, cut) : slice).trimEnd();
  return `${kept}…`;
}

/**
 * True for empty / tiny / explicit stub strings models emit under forced
 * toolChoice — including DeepSeek protocol echoes that passed the min-length
 * check (share wnJWqaRxtCu1I3CLJIgCiaon: `Received: ... first include Text`).
 */
export function isDeskStubText(text: string): boolean {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return true;
  if (/^(placeholder|tbd|todo|n\/?a|none|null|undefined|\.{1,3}|x+|-+)$/i.test(trimmed)) return true;
  if (/\breceived\b/i.test(trimmed) && /first include(?: the)? text/i.test(trimmed)) return true;
  if (/^received:\s*\.{2,}/i.test(trimmed)) return true;
  return false;
}

function readViewpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clipped = clipDeskMarkdown(value, VIEWPOINT_MAX_CHARS);
  if (!clipped || isDeskStubText(clipped) || clipped.length < VIEWPOINT_MIN_CHARS) return undefined;
  return clipped;
}

/**
 * Normalize / bound a publish_desk payload for tool output + UI.
 *
 * When `required` is set (live turn), those specialists must be present and
 * non-stub. Extra specialists are kept only when they are real takes — stubs
 * on non-required fields are dropped, not rejected.
 *
 * When `required` is omitted (share / history recovery), keep any valid
 * specialist fields; need overview + at least one specialist.
 */
export function normalizeDeskBrief(
  input: DeskBriefInput,
  opts?: { required?: readonly DeskViewpointId[] },
): DeskBrief | null {
  const overview = clipDeskMarkdown(String(input.overview ?? ""), OVERVIEW_MAX_CHARS);
  if (!overview || isDeskStubText(overview) || overview.length < OVERVIEW_MIN_CHARS) return null;

  const required = opts?.required;
  const brief: DeskBrief = { overview };
  const bodies: string[] = [];

  for (const id of DESK_VIEWPOINT_IDS) {
    const body = readViewpoint(input[id]);
    if (required?.includes(id)) {
      if (!body) return null;
      brief[id] = body;
      bodies.push(body);
      continue;
    }
    if (body) {
      brief[id] = body;
      bodies.push(body);
    }
  }

  if (required && required.length > 0) {
    // ok — required fields already validated
  } else if (bodies.length === 0) {
    return null;
  }

  // Identical copy-pasted fields are not distinct specialist takes.
  if (bodies.length >= 2 && bodies.every((body) => body === bodies[0])) return null;
  return brief;
}

export function deskViewpointsFromBrief(brief: DeskBrief): DeskViewpoint[] {
  return DESK_VIEWPOINT_IDS
    .filter((id) => typeof brief[id] === "string" && brief[id]!.trim())
    .map((id) => ({
      id,
      label: DESK_VIEWPOINT_LABELS[id],
      body: brief[id]!,
    }));
}

export function formatDeskToolSummary(brief: DeskBrief): string {
  const lines = ["Desk viewpoints published:"];
  for (const viewpoint of deskViewpointsFromBrief(brief)) {
    const preview = viewpoint.body.slice(0, 120);
    lines.push(
      `${viewpoint.label} — ${preview}${viewpoint.body.length > 120 ? "…" : ""}`,
    );
  }
  lines.push(
    `Overview — ${brief.overview.slice(0, 160)}${brief.overview.length > 160 ? "…" : ""}`,
  );
  return lines.join("\n");
}

function formatActiveSpecialists(active: readonly DeskViewpointId[]): string {
  return active.map((id) => DESK_VIEWPOINT_LABELS[id]).join(", ");
}

/** Prompt block describing specialists + overview (shared by system prompt + admin). */
export function deskAnalystBlock(active?: readonly DeskViewpointId[]): string {
  const required = active && active.length > 0 ? active : DESK_CORE_VIEWPOINT_IDS;
  const specialistLines = DESK_VIEWPOINT_IDS.map(
    (id) => `- ${DESK_VIEWPOINT_LABELS[id]} analyst: ${DESK_SPECIALIST_SUMMARIES[id]}`,
  );
  return [
    "You channel a multi-analyst trading desk. Active specialists share the same tool evidence (SQL frames, research_ticker, news, calendar) — they must not invent separate facts.",
    "",
    `Active specialists for this turn (fill ONLY these publish_desk fields — omit the rest): ${formatActiveSpecialists(required)}.`,
    "Available specialists (reference — do not invent panels outside the active list):",
    ...specialistLines,
    `- Desk overview: ${DESK_OVERVIEW_SUMMARY}`,
    "",
    DESK_MARKDOWN_SHAPE,
    "",
    "Desk publishing:",
    `- For ticker deep-dives, trade ideas, why-is-it-moving, and other market analysis, MUST call publish_desk after tools and before any final prose. Fill the active specialist fields (${formatActiveSpecialists(required)}) plus overview with distinct angles grounded in the shared evidence (private personal account bots answer directly in markdown).`,
    "- Omit inactive specialist fields entirely — do not send stub text (\"placeholder\", \"TBD\", \"N/A\") for specialists that are not active this turn.",
    "- Never put stub text (\"placeholder\", \"TBD\", \"TODO\") in publish_desk — incomplete desks are rejected and the turn stalls. Gather research_ticker / SQL / news first, then publish real takes.",
    "- Emit NO assistant prose (no status lines, no \"let me…\", no partial takes) until publish_desk has succeeded. Tool calls only until then.",
    "- Keep each specialist take tight: a short lead plus 2–5 bullets or 2–4 short paragraphs. The overview weighs where the active specialists agree or conflict and states the net take in the same Markdown shape.",
    "- After publish_desk, call suggest_trades (structured trades or empty + skip_reason), then the final message text must be ONLY the desk overview — identical Markdown to the overview field. Do not re-paste the specialist takes or the trade list into the prose; the UI already shows them from the tools.",
    "- Skip publish_desk only for pure schema/SQL mechanics, bare calendar lists, or off-analysis tool housekeeping.",
    "- Never overweight technical analysis: if price action is loud but fundamentals, options liquidity, risk, or macro disagree, say so in the overview.",
    "- Routing examples: single-name options chain (e.g. GME) → fundamental + technical + options + risk, not macro. Broad beta / rates ETFs (SPY, TLT) or Fed/CPI asks → include macro. Risk is always active — downside, sizing, and what breaks the thesis.",
  ].join("\n");
}
