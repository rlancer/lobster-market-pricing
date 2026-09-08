/**
 * Admin probe: run one firm-pipeline cell (approach × as-of case).
 *
 * Reuses the desk OpenRouter complete() helper (system-fold + verdict close-out).
 */

import {
  createDeskCompleteFn,
  resolveDeskExperimentModel,
  type DeskExperimentProbeEnv,
} from "./desk-experiment-probe";
import { caseById, scoreDeskVerdict } from "./desk-experiment";
import { buildDeskExperimentCases } from "./desk-experiment-cases";
import {
  FIRM_APPROACH_IDS,
  firmApproachById,
  runFirmPipelineApproach,
  type FirmApproachId,
  type FirmPipelineRun,
} from "./firm-pipeline";
import type { DeskScore } from "./desk-experiment";

export interface FirmPipelineProbeInput {
  model?: string;
  approach_id: FirmApproachId;
  case_id: string;
}

export interface FirmPipelineProbeSuccess {
  ok: true;
  model: string;
  approach_id: FirmApproachId;
  case_id: string;
  run: FirmPipelineRun;
  score: DeskScore;
}

export interface FirmPipelineProbeFailure {
  ok: false;
  error: string;
  status: number;
}

export type FirmPipelineProbeParseResult =
  | ({ ok: true } & FirmPipelineProbeInput)
  | FirmPipelineProbeFailure;

export function parseFirmPipelineProbeBody(body: unknown): FirmPipelineProbeParseResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "JSON body required", status: 400 };
  }
  const rec = body as Record<string, unknown>;
  const approachRaw = typeof rec.approach_id === "string" ? rec.approach_id.trim() : "";
  if (!FIRM_APPROACH_IDS.includes(approachRaw as FirmApproachId)) {
    return { ok: false, error: "approach_id is required", status: 400 };
  }
  const caseRaw = typeof rec.case_id === "string" ? rec.case_id.trim() : "";
  if (!caseRaw || !caseById(caseRaw)) {
    return { ok: false, error: "case_id is required and must be a known case", status: 400 };
  }
  const model = typeof rec.model === "string" && rec.model.trim()
    ? rec.model.trim().slice(0, 120)
    : undefined;
  if (!firmApproachById(approachRaw)) {
    return { ok: false, error: "unknown approach_id", status: 400 };
  }
  return {
    ok: true,
    model,
    approach_id: approachRaw as FirmApproachId,
    case_id: caseRaw,
  };
}

export async function runFirmPipelineProbe(
  env: DeskExperimentProbeEnv,
  origin: string,
  input: FirmPipelineProbeInput,
): Promise<FirmPipelineProbeSuccess | FirmPipelineProbeFailure> {
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
    const run = await runFirmPipelineApproach(input.approach_id, experimentCase, complete);
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
