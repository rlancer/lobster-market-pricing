/**
 * Admin probe: run one desk-approaches cell (approach × as-of case).
 */

import { generateText, type LanguageModel } from "ai";
import { createChatModel, type ChatModelEnv } from "./chat-contract";
import {
  DESK_APPROACH_IDS,
  approachById,
  caseById,
  runDeskApproach,
  scoreDeskVerdict,
  type CompleteFn,
  type DeskApproachId,
  type DeskApproachRun,
  type DeskScore,
} from "./desk-experiment";
import { buildDeskExperimentCases } from "./desk-experiment-cases";

export const DEFAULT_DESK_EXPERIMENT_MODEL = "openai/gpt-4o-mini";

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

export async function runDeskExperimentProbe(
  env: ChatModelEnv,
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

  const modelId = input.model?.trim() || DEFAULT_DESK_EXPERIMENT_MODEL;
  const model = createChatModel(
    { OPEN_ROUTER_KEY: env.OPEN_ROUTER_KEY, COPILOT_MODEL: modelId },
    origin,
  ) as LanguageModel;

  const complete: CompleteFn = async ({ messages, maxOutputTokens }) => {
    const started = Date.now();
    const result = await generateText({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      maxOutputTokens: maxOutputTokens ?? 1_200,
      temperature: 0,
    });
    return { text: result.text, latency_ms: Date.now() - started };
  };

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
