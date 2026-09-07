/**
 * Desk-approaches experiment: compare how we get a market take.
 *
 * Production Analyst desk is one CopilotAgent session (one Durable Object)
 * where a single model role-plays specialists via publish_desk. This harness
 * holds the evidence pack frozen at an as-of date and varies session
 * structure — solo vs that role-play vs real isolated specialist sessions.
 */

import {
  DESK_CORE_VIEWPOINT_IDS,
  DESK_SPECIALIST_SUMMARIES,
  DESK_VIEWPOINT_LABELS,
  deskAnalystBlock,
  normalizeDeskBrief,
  type DeskBrief,
  type DeskViewpointId,
} from "./chat-desk";
import {
  DESK_EXPERIMENT_AS_OF_INDEX,
  DESK_EXPERIMENT_SEED,
  DESK_EXPERIMENT_START_DATE,
  DESK_EXPERIMENT_TRADING_DAYS,
  buildDeskExperimentCases,
  formatDeskSnapshot,
  type DeskExperimentCase,
  type DeskLean,
} from "./desk-experiment-cases";

export const DESK_EXPERIMENT_SLUG = "desk-approaches";
export const DESK_EXPERIMENT_DESIGN_ID = "desk-approaches-v2";
export const DESK_EXPERIMENT_RUNNER_VERSION = 2;
export const DESK_EXPERIMENT_DEADBAND_PCT = 1.5;
/** Per OpenRouter seat. 4 min aborted live 5-seat DeepSeek cells mid-matrix. */
export const DESK_SEAT_ABORT_MS = 6 * 60_000;
/** Close-out after high-reasoning CoT — small budget, no extra chain-of-thought. */
export const DESK_VERDICT_CLOSE_ABORT_MS = 45_000;
export const DESK_VERDICT_CLOSE_MAX_TOKENS = 384;
/** Hard cap so a hung OpenRouter call cannot freeze the remaining matrix. */
export const DESK_CELL_TIMEOUT_MS = 30 * 60_000;

export const DESK_APPROACH_IDS = [
  "solo",
  "desk_roleplay",
  "desk_shared_session",
  "desk_fresh_sessions",
] as const;
export type DeskApproachId = (typeof DESK_APPROACH_IDS)[number];

export interface DeskApproachMeta {
  id: DeskApproachId;
  label: string;
  description: string;
  /** Distinct generateText conversations used for one cell. */
  session_mode: "one" | "shared_turns" | "fresh_per_specialist";
}

export const DESK_APPROACHES: DeskApproachMeta[] = [
  {
    id: "solo",
    label: "Solo analyst",
    description:
      "One session, one voice, no specialist panels. Closest to 'just answer the question'.",
    session_mode: "one",
  },
  {
    id: "desk_roleplay",
    label: "Analyst desk role-play",
    description:
      "Current production: one session, one model, publish_desk specialists sharing the same snapshot. Not separate agents.",
    session_mode: "one",
  },
  {
    id: "desk_shared_session",
    label: "Shared session specialists",
    description:
      "One conversation. Specialists take turns in order (fundamental → technical → options → risk), then a chair. Later voices see earlier takes.",
    session_mode: "shared_turns",
  },
  {
    id: "desk_fresh_sessions",
    label: "New session per specialist",
    description:
      "Each specialist starts a blank session with only the frozen snapshot. A chair session then sees the takes (and the snapshot) and writes the overview.",
    session_mode: "fresh_per_specialist",
  },
];

export const DESK_EXPERIMENT_AS_OF_RULES = [
  "You are grading a frozen as-of tape. The snapshot date is TODAY.",
  "Use ONLY the supplied snapshot. Do not use world knowledge, later prices, or later news.",
  "Tickers in this pack are invented. Do not recall real-market outcomes.",
  "If a number is not in the snapshot, say you do not have it — do not invent a print.",
].join(" ");

export const DESK_VERDICT_INSTRUCTIONS = [
  "End with a JSON object (and nothing after it) of the form:",
  '{"lean_5d":"bullish|bearish|neutral","lean_20d":"bullish|bearish|neutral","confidence_5d":0.0,"confidence_20d":0.0,"thesis":"one or two sentences"}',
  "lean_5d / lean_20d are the directional call for the next 5 and 20 sessions after as-of.",
  "neutral only when you genuinely have no edge inside a ~1.5% deadband.",
].join(" ");

export interface DeskVerdict {
  lean_5d: DeskLean;
  lean_20d: DeskLean;
  confidence_5d: number;
  confidence_20d: number;
  thesis: string;
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteRequest {
  messages: ChatTurn[];
  maxOutputTokens?: number;
  /** Verdict turns must close with lean_5d/lean_20d JSON. */
  kind?: "prose" | "verdict";
}

export type CompleteFn = (input: CompleteRequest) => Promise<{ text: string; latency_ms: number }>;

export interface DeskSessionTrace {
  id: string;
  specialist: DeskViewpointId | "chair" | "solo";
  messages: ChatTurn[];
  text: string;
}

export interface DeskApproachRun {
  approach_id: DeskApproachId;
  case_id: string;
  sessions: DeskSessionTrace[];
  session_count: number;
  llm_calls: number;
  answer: string;
  desk: DeskBrief | null;
  verdict: DeskVerdict | null;
  parse_error: string | null;
  latency_ms: number;
}

export interface DeskScore {
  actual_5d: DeskLean;
  actual_20d: DeskLean;
  correct_5d: boolean;
  correct_20d: boolean;
  /** Both horizons match. */
  correct: boolean;
  signed_5d: number;
  signed_20d: number;
  detail: string;
}

export function leanFromReturn(returnPct: number, deadband = DESK_EXPERIMENT_DEADBAND_PCT): DeskLean {
  if (returnPct > deadband) return "bullish";
  if (returnPct < -deadband) return "bearish";
  return "neutral";
}

export function parseLean(value: unknown): DeskLean | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (raw === "bullish" || raw === "long" || raw === "up" || raw === "buy") return "bullish";
  if (raw === "bearish" || raw === "short" || raw === "down" || raw === "sell") return "bearish";
  if (raw === "neutral" || raw === "flat" || raw === "none" || raw === "sideways") return "neutral";
  return null;
}

function clamp01(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** All brace-matched JSON objects in the text (fenced blocks first, then raw). */
export function parseJsonObjects(text: string): Record<string, unknown>[] {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const blobs: string[] = fences.map((m) => m[1]!.trim());
  blobs.push(text);
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const blob of blobs) {
    for (const candidate of collectJsonCandidates(blob)) {
      if (seen.has(candidate)) continue;
      try {
        const value = JSON.parse(candidate) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          seen.add(candidate);
          out.push(value as Record<string, unknown>);
        }
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/** Last JSON object in the text (fenced or brace-matched). */
export function extractLastJsonObject(text: string): Record<string, unknown> | null {
  const objects = parseJsonObjects(text);
  return objects.at(-1) ?? null;
}

function collectJsonCandidates(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!;
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

export function extractDeskVerdict(text: string): DeskVerdict | null {
  const objects = parseJsonObjects(text);
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i]!;
    const lean_5d = parseLean(obj.lean_5d);
    const lean_20d = parseLean(obj.lean_20d);
    if (!lean_5d || !lean_20d) continue;
    const thesis = typeof obj.thesis === "string" ? obj.thesis.trim().slice(0, 480) : "";
    return {
      lean_5d,
      lean_20d,
      confidence_5d: clamp01(obj.confidence_5d),
      confidence_20d: clamp01(obj.confidence_20d),
      thesis: thesis || "No thesis.",
    };
  }
  return null;
}

export function extractDeskFromText(text: string, required = DESK_CORE_VIEWPOINT_IDS): DeskBrief | null {
  const obj = extractLastJsonObject(text);
  if (!obj) return null;
  return normalizeDeskBrief({
    fundamental: typeof obj.fundamental === "string" ? obj.fundamental : null,
    technical: typeof obj.technical === "string" ? obj.technical : null,
    options: typeof obj.options === "string" ? obj.options : null,
    risk: typeof obj.risk === "string" ? obj.risk : null,
    macro: typeof obj.macro === "string" ? obj.macro : null,
    overview: typeof obj.overview === "string" ? obj.overview : null,
  }, { required });
}

export function signedLeanScore(predicted: DeskLean, actual: DeskLean): number {
  if (predicted === actual) return 1;
  if (predicted === "neutral" || actual === "neutral") return 0;
  return -1;
}

export function scoreDeskVerdict(
  verdict: DeskVerdict | null,
  experimentCase: DeskExperimentCase,
): DeskScore {
  const actual_5d = leanFromReturn(experimentCase.outcome.return_5d_pct);
  const actual_20d = leanFromReturn(experimentCase.outcome.return_20d_pct);
  if (!verdict) {
    return {
      actual_5d,
      actual_20d,
      correct_5d: false,
      correct_20d: false,
      correct: false,
      signed_5d: 0,
      signed_20d: 0,
      detail: `no verdict parsed; actual 5d ${actual_5d} (${experimentCase.outcome.return_5d_pct}%), 20d ${actual_20d} (${experimentCase.outcome.return_20d_pct}%)`,
    };
  }
  const correct_5d = verdict.lean_5d === actual_5d;
  const correct_20d = verdict.lean_20d === actual_20d;
  return {
    actual_5d,
    actual_20d,
    correct_5d,
    correct_20d,
    correct: correct_5d && correct_20d,
    signed_5d: signedLeanScore(verdict.lean_5d, actual_5d),
    signed_20d: signedLeanScore(verdict.lean_20d, actual_20d),
    detail: [
      `5d ${verdict.lean_5d} vs ${actual_5d} (${experimentCase.outcome.return_5d_pct}%)`,
      `20d ${verdict.lean_20d} vs ${actual_20d} (${experimentCase.outcome.return_20d_pct}%)`,
    ].join("; "),
  };
}

export function deskExperimentUserPacket(experimentCase: DeskExperimentCase): string {
  return [
    formatDeskSnapshot(experimentCase.snapshot),
    "",
    "QUESTION:",
    experimentCase.prompt,
  ].join("\n");
}

export function deskSoloSystemPrompt(): string {
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    "You are a single market analyst. No specialist panels. Write a tight Markdown take, then the verdict JSON.",
    DESK_VERDICT_INSTRUCTIONS,
  ].join("\n");
}

function deskJsonHint(): string {
  return [
    "Also include specialist fields in the same JSON (or a prior JSON):",
    '{"fundamental":"...","technical":"...","options":"...","risk":"...","overview":"...","lean_5d":"...","lean_20d":"...","confidence_5d":0,"confidence_20d":0,"thesis":"..."}',
    "Each specialist field must be a real take (not placeholder), distinct from the others.",
  ].join(" ");
}

export function deskRoleplaySystemPrompt(): string {
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    deskAnalystBlock(DESK_CORE_VIEWPOINT_IDS),
    "This is a single session. Do not pretend other agents exist — you write every specialist take yourself.",
    deskJsonHint(),
    DESK_VERDICT_INSTRUCTIONS,
  ].join("\n");
}

export function deskSharedSystemPrompt(): string {
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    "This is one shared conversation. You will be asked to speak as one specialist at a time, then as chair.",
    "Stay in the requested seat. Later seats may disagree with earlier ones.",
  ].join("\n");
}

export function deskSharedSpecialistUser(id: DeskViewpointId, packet: string | null): string {
  return [
    packet ?? "Same frozen snapshot as the first turn.",
    "",
    `Now speak only as the ${DESK_VIEWPOINT_LABELS[id]} specialist.`,
    DESK_SPECIALIST_SUMMARIES[id],
    "Do not emit verdict JSON yet.",
  ].join("\n");
}

export function deskSharedChairUser(): string {
  return [
    "Now speak as the desk chair. Weigh the specialist takes above.",
    "Write overview Markdown, then the verdict JSON.",
    DESK_VERDICT_INSTRUCTIONS,
  ].join("\n");
}

export function deskSpecialistSystemPrompt(id: DeskViewpointId): string {
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    `You are the ${DESK_VIEWPOINT_LABELS[id]} specialist only.`,
    DESK_SPECIALIST_SUMMARIES[id],
    "Write a distinct take grounded in the snapshot. Do not speak for other specialists.",
    "Do not emit the verdict JSON — the chair will do that.",
  ].join("\n");
}

export function deskChairSystemPrompt(): string {
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    "You are the desk chair. Weigh the specialist takes. Do not invent facts they did not have.",
    "Write an overview, then the verdict JSON.",
    DESK_VERDICT_INSTRUCTIONS,
  ].join("\n");
}

async function call(
  complete: CompleteFn,
  messages: ChatTurn[],
  maxOutputTokens = 1_200,
  kind: "prose" | "verdict" = "prose",
): Promise<{ text: string; latency_ms: number }> {
  return complete({ messages, maxOutputTokens, kind });
}

export async function runDeskApproach(
  approachId: DeskApproachId,
  experimentCase: DeskExperimentCase,
  complete: CompleteFn,
): Promise<DeskApproachRun> {
  if (approachId === "solo") return runSolo(experimentCase, complete);
  if (approachId === "desk_roleplay") return runRoleplay(experimentCase, complete);
  if (approachId === "desk_shared_session") return runShared(experimentCase, complete);
  return runFresh(experimentCase, complete);
}

async function runSolo(
  experimentCase: DeskExperimentCase,
  complete: CompleteFn,
): Promise<DeskApproachRun> {
  const messages: ChatTurn[] = [
    { role: "system", content: deskSoloSystemPrompt() },
    { role: "user", content: deskExperimentUserPacket(experimentCase) },
  ];
  const result = await call(complete, messages, 2_400, "verdict");
  return finalize(experimentCase, "solo", [{
    id: "solo",
    specialist: "solo",
    messages,
    text: result.text,
  }], result.text, 1, result.latency_ms, null);
}

async function runRoleplay(
  experimentCase: DeskExperimentCase,
  complete: CompleteFn,
): Promise<DeskApproachRun> {
  const messages: ChatTurn[] = [
    { role: "system", content: deskRoleplaySystemPrompt() },
    { role: "user", content: deskExperimentUserPacket(experimentCase) },
  ];
  const result = await call(complete, messages, 2_400, "verdict");
  const desk = extractDeskFromText(result.text);
  return finalize(experimentCase, "desk_roleplay", [{
    id: "desk",
    specialist: "chair",
    messages,
    text: result.text,
  }], result.text, 1, result.latency_ms, desk);
}

async function runShared(
  experimentCase: DeskExperimentCase,
  complete: CompleteFn,
): Promise<DeskApproachRun> {
  const sessions: DeskSessionTrace[] = [];
  const messages: ChatTurn[] = [
    { role: "system", content: deskSharedSystemPrompt() },
  ];
  let latency = 0;
  const packet = deskExperimentUserPacket(experimentCase);
  const takes: Partial<Record<DeskViewpointId, string>> = {};

  for (const id of DESK_CORE_VIEWPOINT_IDS) {
    messages.push({
      role: "user",
      content: deskSharedSpecialistUser(id, messages.length === 1 ? packet : null),
    });
    const result = await call(complete, messages);
    latency += result.latency_ms;
    messages.push({ role: "assistant", content: result.text });
    takes[id] = result.text;
    sessions.push({
      id,
      specialist: id,
      messages: messages.map((m) => ({ ...m })),
      text: result.text,
    });
  }

  messages.push({
    role: "user",
    content: deskSharedChairUser(),
  });
  const chair = await call(complete, messages, 1_600, "verdict");
  latency += chair.latency_ms;
  sessions.push({
    id: "chair",
    specialist: "chair",
    messages: [...messages, { role: "assistant", content: chair.text }],
    text: chair.text,
  });

  const desk = normalizeDeskBrief({
    fundamental: takes.fundamental,
    technical: takes.technical,
    options: takes.options,
    risk: takes.risk,
    overview: chair.text,
  }, { required: DESK_CORE_VIEWPOINT_IDS });

  return finalize(experimentCase, "desk_shared_session", sessions, chair.text, 1, latency, desk);
}

async function runFresh(
  experimentCase: DeskExperimentCase,
  complete: CompleteFn,
): Promise<DeskApproachRun> {
  const sessions: DeskSessionTrace[] = [];
  const takes: Partial<Record<DeskViewpointId, string>> = {};
  let latency = 0;
  const packet = deskExperimentUserPacket(experimentCase);

  for (const id of DESK_CORE_VIEWPOINT_IDS) {
    const messages: ChatTurn[] = [
      { role: "system", content: deskSpecialistSystemPrompt(id) },
      { role: "user", content: packet },
    ];
    const result = await call(complete, messages);
    latency += result.latency_ms;
    takes[id] = result.text;
    sessions.push({ id, specialist: id, messages, text: result.text });
  }

  const chairMessages: ChatTurn[] = [
    { role: "system", content: deskChairSystemPrompt() },
    {
      role: "user",
      content: [
        packet,
        "",
        "Specialist takes (each written in a separate session; they have not read each other):",
        ...DESK_CORE_VIEWPOINT_IDS.map((id) =>
          `### ${DESK_VIEWPOINT_LABELS[id]}\n${takes[id] ?? "(missing)"}`
        ),
        "",
        "Write the overview, then the verdict JSON.",
      ].join("\n"),
    },
  ];
  const chair = await call(complete, chairMessages, 1_600, "verdict");
  latency += chair.latency_ms;
  sessions.push({
    id: "chair",
    specialist: "chair",
    messages: chairMessages,
    text: chair.text,
  });

  const desk = normalizeDeskBrief({
    fundamental: takes.fundamental,
    technical: takes.technical,
    options: takes.options,
    risk: takes.risk,
    overview: chair.text,
  }, { required: DESK_CORE_VIEWPOINT_IDS });

  return finalize(
    experimentCase,
    "desk_fresh_sessions",
    sessions,
    chair.text,
    sessions.length,
    latency,
    desk,
  );
}

function finalize(
  experimentCase: DeskExperimentCase,
  approachId: DeskApproachId,
  sessions: DeskSessionTrace[],
  answer: string,
  sessionCount: number,
  latencyMs: number,
  desk: DeskBrief | null,
): DeskApproachRun {
  const verdict = extractDeskVerdict(answer);
  return {
    approach_id: approachId,
    case_id: experimentCase.id,
    sessions,
    session_count: sessionCount,
    llm_calls: sessions.length,
    answer,
    desk,
    verdict,
    parse_error: verdict ? null : "could not parse lean_5d/lean_20d JSON",
    latency_ms: latencyMs,
  };
}

export function approachById(id: string): DeskApproachMeta | undefined {
  return DESK_APPROACHES.find((row) => row.id === id);
}

export function caseById(
  id: string,
  cases: DeskExperimentCase[] = buildDeskExperimentCases(),
): DeskExperimentCase | undefined {
  return cases.find((row) => row.id === id);
}

/** Public methodology payload (snapshot text is as-of clipped; outcomes are the grade). */
export function deskExperimentDesignPublic() {
  const cases = buildDeskExperimentCases();
  return {
    design_id: DESK_EXPERIMENT_DESIGN_ID,
    slug: DESK_EXPERIMENT_SLUG,
    runner_version: DESK_EXPERIMENT_RUNNER_VERSION,
    production_note:
      "Live Chat Analyst desk is one CopilotAgent Durable Object per conversation. Specialists are role-play via publish_desk in that single session — we do not spawn a new agent session per specialist. Probes use the same OpenRouter model as Chat (COPILOT_MODEL, currently deepseek/deepseek-v4-flash-0731). Held-out 5d/20d continues the as-of tape — it is not a hidden sequel. This experiment tests whether that desk structure is actually the better take.",
    as_of_rules: DESK_EXPERIMENT_AS_OF_RULES,
    verdict_instructions: DESK_VERDICT_INSTRUCTIONS,
    system_prompt: deskExperimentSystemPrompt(),
    deadband_pct: DESK_EXPERIMENT_DEADBAND_PCT,
    seed: DESK_EXPERIMENT_SEED,
    seed_hex: `0x${DESK_EXPERIMENT_SEED.toString(16)}`,
    start_date: DESK_EXPERIMENT_START_DATE,
    trading_days: DESK_EXPERIMENT_TRADING_DAYS,
    as_of_index: DESK_EXPERIMENT_AS_OF_INDEX,
    scoring: {
      rule:
        "A cell is correct only when both lean_5d and lean_20d match the held-out tape. Neutral is the grade when the subsequent move is inside the deadband — not a hedge for a missed direction.",
      deadband_pct: DESK_EXPERIMENT_DEADBAND_PCT,
      both_horizons_required: true,
    },
    runner: {
      execution:
        "Seats run in-process against OpenRouter from GitHub Actions. The Worker HTTP probe cannot finish a 5-seat DeepSeek cell inside one request.",
      seat_abort_ms: DESK_SEAT_ABORT_MS,
      verdict_close_abort_ms: DESK_VERDICT_CLOSE_ABORT_MS,
      verdict_close_max_tokens: DESK_VERDICT_CLOSE_MAX_TOKENS,
      cell_timeout_ms: DESK_CELL_TIMEOUT_MS,
      openrouter_system:
        "OpenRouter rejects role:system inside messages. System turns fold into generateText({ system }).",
      verdict_close_out:
        "If the first verdict turn has no parseable lean_5d/lean_20d JSON, one generateText follow-up with reasoning none. generateObject is not used — flash models hang past AbortSignal.",
      completion_text:
        "Grade the union of text and reasoningText. DeepSeek high reasoning often puts the take in the reasoning channel.",
    },
    specialists: DESK_CORE_VIEWPOINT_IDS.map((id) => ({
      id,
      label: DESK_VIEWPOINT_LABELS[id],
      summary: DESK_SPECIALIST_SUMMARIES[id],
    })),
    approach_inputs: DESK_APPROACHES.map((row) => {
      if (row.id === "solo") {
        return { id: row.id, system_prompt: deskSoloSystemPrompt() };
      }
      if (row.id === "desk_roleplay") {
        return { id: row.id, system_prompt: deskRoleplaySystemPrompt() };
      }
      if (row.id === "desk_shared_session") {
        return {
          id: row.id,
          system_prompt: deskSharedSystemPrompt(),
          specialist_turns: DESK_CORE_VIEWPOINT_IDS.map((id) => ({
            id,
            label: DESK_VIEWPOINT_LABELS[id],
            user_instruction: deskSharedSpecialistUser(id, null),
          })),
          chair_turn: deskSharedChairUser(),
        };
      }
      return {
        id: row.id,
        specialist_system: Object.fromEntries(
          DESK_CORE_VIEWPOINT_IDS.map((id) => [id, deskSpecialistSystemPrompt(id)]),
        ),
        chair_system: deskChairSystemPrompt(),
      };
    }),
    approaches: DESK_APPROACHES,
    cases: cases.map((row) => ({
      id: row.id,
      ticker: row.snapshot.ticker,
      name: row.snapshot.name,
      as_of: row.snapshot.as_of,
      prompt: row.prompt,
      notes: row.notes,
      expected_5d: leanFromReturn(row.outcome.return_5d_pct),
      expected_20d: leanFromReturn(row.outcome.return_20d_pct),
      return_5d_pct: row.outcome.return_5d_pct,
      return_20d_pct: row.outcome.return_20d_pct,
      what_happened: row.outcome.what_happened,
      snapshot_text: formatDeskSnapshot(row.snapshot),
      user_packet: deskExperimentUserPacket(row),
    })),
  };
}

export function deskExperimentSystemPrompt(): string {
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    DESK_VERDICT_INSTRUCTIONS,
    "Approaches differ only in session structure (solo / role-play desk / shared session / fresh sessions).",
  ].join("\n");
}
