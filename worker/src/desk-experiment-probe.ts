/**
 * Admin probe: run one desk-approaches cell (approach × as-of case).
 */

import { generateObject, generateText, type LanguageModel } from "ai";
import { z } from "zod";
import { createChatModel, type ChatModelEnv } from "./chat-contract";
import {
  DESK_APPROACH_IDS,
  DESK_VERDICT_INSTRUCTIONS,
  approachById,
  caseById,
  extractDeskVerdict,
  runDeskApproach,
  scoreDeskVerdict,
  type CompleteFn,
  type DeskApproachId,
  type DeskApproachRun,
  type DeskScore,
} from "./desk-experiment";
import { buildDeskExperimentCases } from "./desk-experiment-cases";

/** Fallback when the Worker has no COPILOT_MODEL — same slug as wrangler.jsonc. */
export const DEFAULT_DESK_EXPERIMENT_MODEL = "deepseek/deepseek-v4-flash-0731";

export interface DeskExperimentProbeEnv extends ChatModelEnv {
  COPILOT_REASONING_EFFORT?: string;
  COPILOT_MAX_OUTPUT_TOKENS?: string;
}

export function resolveDeskExperimentModel(
  env: { COPILOT_MODEL?: string },
  inputModel?: string,
): string {
  return inputModel?.trim() || env.COPILOT_MODEL?.trim() || DEFAULT_DESK_EXPERIMENT_MODEL;
}

function normalizeReasoningEffort(value: string | undefined): "xhigh" | "high" | "medium" | "low" | "minimal" | "none" {
  const effort = value?.trim() || "high";
  return ["xhigh", "high", "medium", "low", "minimal", "none"].includes(effort)
    ? effort as "xhigh" | "high" | "medium" | "low" | "minimal" | "none"
    : "high";
}

function maxOutputTokenBudget(env: DeskExperimentProbeEnv, requested?: number): number {
  const fromEnv = Number.parseInt(env.COPILOT_MAX_OUTPUT_TOKENS || "8192", 10);
  const cap = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 8192;
  if (typeof requested === "number" && requested > 0) return Math.max(requested, cap);
  return cap;
}

/** Per OpenRouter call. Hung DeepSeek seats were ~10 min and killed the Worker request. */
const COMPLETE_ABORT_MS = 6 * 60_000;
/** Close-out after high-reasoning CoT — small budget, no extra chain-of-thought. */
const VERDICT_CLOSE_ABORT_MS = 2 * 60_000;
const VERDICT_CLOSE_MAX_TOKENS = 384;

const deskVerdictSchema = z.object({
  lean_5d: z.enum(["bullish", "bearish", "neutral"]),
  lean_20d: z.enum(["bullish", "bearish", "neutral"]),
  confidence_5d: z.number().min(0).max(1).optional(),
  confidence_20d: z.number().min(0).max(1).optional(),
  thesis: z.string().max(480).optional(),
});

/**
 * DeepSeek-v4 with high reasoning often puts the take (and the verdict JSON)
 * in `reasoningText` while `text` is empty. Grade the union, not the visible
 * channel alone.
 */
export function deskCompletionText(result: {
  text?: string;
  reasoningText?: string;
}): string {
  const visible = typeof result.text === "string" ? result.text.trim() : "";
  const reasoning = typeof result.reasoningText === "string" ? result.reasoningText.trim() : "";
  if (visible && reasoning && visible !== reasoning) return `${visible}\n\n${reasoning}`;
  return visible || reasoning;
}

export interface DeskExperimentProbeInput {
  model?: string;
  approach_id: DeskApproachId;
  case_id: string;
}

export interface DeskExperimentProbeSuccess {
  ok: true;
  model: string;
  approach_id: DeskApproachId;
  case_id: string;
  run: DeskApproachRun;
  score: DeskScore;
}

export interface DeskExperimentProbeFailure {
  ok: false;
  error: string;
  status: number;
}

export type DeskExperimentProbeParseResult =
  | ({ ok: true } & DeskExperimentProbeInput)
  | DeskExperimentProbeFailure;

export function parseDeskExperimentProbeBody(body: unknown): DeskExperimentProbeParseResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "JSON body required", status: 400 };
  }
  const rec = body as Record<string, unknown>;
  const approachRaw = typeof rec.approach_id === "string" ? rec.approach_id.trim() : "";
  if (!DESK_APPROACH_IDS.includes(approachRaw as DeskApproachId)) {
    return { ok: false, error: "approach_id is required", status: 400 };
  }
  const caseRaw = typeof rec.case_id === "string" ? rec.case_id.trim() : "";
  if (!caseRaw || !caseById(caseRaw)) {
    return { ok: false, error: "case_id is required and must be a known case", status: 400 };
  }
  const model = typeof rec.model === "string" && rec.model.trim()
    ? rec.model.trim().slice(0, 120)
    : undefined;
  if (!approachById(approachRaw)) {
    return { ok: false, error: "unknown approach_id", status: 400 };
  }
  return {
    ok: true,
    model,
    approach_id: approachRaw as DeskApproachId,
    case_id: caseRaw,
  };
}

/**
 * OpenRouter / Responses-API rejects `role: "system"` inside `messages`.
 * Fold those into `system` (mapped to `instructions`) and keep user/assistant turns.
 */
export function splitSystemMessages(messages: Array<{ role: string; content: string }>): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const rest: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.trim()) systemParts.push(message.content);
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      rest.push({ role: message.role, content: message.content });
    }
  }
  return { system: systemParts.join("\n\n"), messages: rest };
}

function serializeClosedVerdict(value: z.infer<typeof deskVerdictSchema>): string {
  return JSON.stringify({
    lean_5d: value.lean_5d,
    lean_20d: value.lean_20d,
    confidence_5d: value.confidence_5d ?? 0,
    confidence_20d: value.confidence_20d ?? 0,
    thesis: value.thesis ?? "",
  });
}

/**
 * High-reasoning DeepSeek often dumps CoT and never closes lean_5d/lean_20d.
 * One follow-up with reasoning none, then generateObject — same model, not a hide.
 */
async function closeDeskVerdict(
  model: LanguageModel,
  split: ReturnType<typeof splitSystemMessages>,
  firstText: string,
): Promise<string> {
  const closeSystem = [
    split.system,
    "The analysis is finished. Reply with ONLY the JSON object — no markdown fences, no chain of thought.",
    DESK_VERDICT_INSTRUCTIONS,
  ].filter((part) => part.trim()).join("\n\n");
  const closeMessages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...split.messages,
    { role: "assistant", content: firstText.slice(0, 6_000) },
    {
      role: "user",
      content: "Emit the verdict JSON now. ONLY the JSON object with lean_5d and lean_20d.",
    },
  ];

  try {
    const follow = await generateText({
      model,
      ...(closeSystem ? { system: closeSystem } : {}),
      messages: closeMessages,
      maxOutputTokens: VERDICT_CLOSE_MAX_TOKENS,
      temperature: 0,
      abortSignal: AbortSignal.timeout(VERDICT_CLOSE_ABORT_MS),
      providerOptions: {
        openrouter: { reasoning: { effort: "none" } },
      },
    });
    const extra = deskCompletionText(follow);
    const combined = extra ? `${firstText}\n\n${extra}` : firstText;
    if (extractDeskVerdict(combined)) return combined;
  } catch (error) {
    console.warn(JSON.stringify({
      deskVerdict: true,
      phase: "generateText",
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  try {
    const result = await generateObject({
      model,
      schema: deskVerdictSchema,
      ...(closeSystem ? { system: closeSystem } : {}),
      prompt: [
        "Prior analysis:",
        firstText.slice(-4_000),
        "",
        "Emit lean_5d, lean_20d, confidence_5d, confidence_20d, thesis.",
      ].join("\n"),
      maxOutputTokens: VERDICT_CLOSE_MAX_TOKENS,
      temperature: 0,
      abortSignal: AbortSignal.timeout(VERDICT_CLOSE_ABORT_MS),
      providerOptions: {
        openrouter: { reasoning: { effort: "none" } },
      },
    });
    return `${firstText}\n\n${serializeClosedVerdict(result.object)}`;
  } catch (error) {
    console.warn(JSON.stringify({
      deskVerdict: true,
      phase: "generateObject",
      error: error instanceof Error ? error.message : String(error),
    }));
    return firstText;
  }
}

export function createDeskCompleteFn(
  env: DeskExperimentProbeEnv,
  origin: string,
  modelId: string,
): CompleteFn {
  const model = createChatModel(
    { OPEN_ROUTER_KEY: env.OPEN_ROUTER_KEY, COPILOT_MODEL: modelId },
    origin,
  ) as LanguageModel;
  const reasoningEffort = normalizeReasoningEffort(env.COPILOT_REASONING_EFFORT);
  return async ({ messages, maxOutputTokens, kind }) => {
    const started = Date.now();
    const split = splitSystemMessages(messages);
    const result = await generateText({
      model,
      ...(split.system ? { system: split.system } : {}),
      messages: split.messages,
      maxOutputTokens: maxOutputTokenBudget(env, maxOutputTokens),
      temperature: 0,
      abortSignal: AbortSignal.timeout(COMPLETE_ABORT_MS),
      providerOptions: {
        openrouter: { reasoning: { effort: reasoningEffort } },
      },
    });
    let text = deskCompletionText(result);
    if (kind === "verdict" && !extractDeskVerdict(text)) {
      text = await closeDeskVerdict(model, split, text);
    }
    return { text, latency_ms: Date.now() - started };
  };
}

export async function runDeskExperimentProbe(
  env: DeskExperimentProbeEnv,
  origin: string,
  input: DeskExperimentProbeInput,
): Promise<DeskExperimentProbeSuccess | DeskExperimentProbeFailure> {
  if (!env.OPEN_ROUTER_KEY?.trim()) {
    return { ok: false, error: "OPEN_ROUTER_KEY is not configured", status: 503 };
  }
  const experimentCase = caseById(input.case_id, buildDeskExperimentCases());
  if (!experimentCase) {
    return { ok: false, error: "unknown case_id", status: 400 };
  }

  const modelId = resolveDeskExperimentModel(env, input.model);
  const complete = createDeskCompleteFn(env, origin, modelId);

  try {
    const run = await runDeskApproach(input.approach_id, experimentCase, complete);
    const score = scoreDeskVerdict(run.verdict, experimentCase);
    return {
      ok: true,
      model: modelId,
      approach_id: input.approach_id,
      case_id: input.case_id,
      run,
      score,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.slice(0, 500), status: 502 };
  }
}
