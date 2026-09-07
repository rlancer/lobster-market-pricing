/**
 * Persist desk-approaches experiment runs in experiment_runs.
 *
 * Same table as text-vs-image; different design_id. Approaches map to
 * representations, cases map to questions. Images may be empty.
 */

import type {
  ExperimentRunCell,
  ExperimentRunManifest,
  ExperimentRunQuestion,
  ExperimentRunResults,
  ExperimentRunTextRep,
  ParseSaveResult,
  SaveExperimentRunInput,
} from "./experiment-runs";
import {
  DESK_APPROACHES,
  DESK_EXPERIMENT_RUNNER_VERSION,
  DESK_EXPERIMENT_SLUG,
  deskExperimentSystemPrompt,
} from "./desk-experiment";

const MAX_RESULTS_CHARS = 400_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isHash(value: string | null): value is string {
  return Boolean(value && /^[a-f0-9]{64}$/.test(value));
}

export function isDeskExperimentDesignId(designId: string): boolean {
  return designId.startsWith("desk-approaches");
}

export async function parseSaveDeskExperimentRunBody(
  body: unknown,
  slugFromPath: string,
): Promise<ParseSaveResult> {
  if (!isRecord(body)) {
    return { ok: false, error: "JSON body required", status: 400 };
  }

  const slug = asString(body.experiment_slug, 80) ?? slugFromPath;
  if (slug !== slugFromPath) {
    return { ok: false, error: "experiment_slug must match path", status: 400 };
  }
  if (slug !== DESK_EXPERIMENT_SLUG) {
    return { ok: false, error: "invalid experiment_slug for desk-approaches", status: 400 };
  }

  const model = asString(body.model, 120);
  if (!model) return { ok: false, error: "model is required", status: 400 };

  const seedRaw = body.seed;
  const seed = typeof seedRaw === "number" && Number.isFinite(seedRaw)
    ? Math.trunc(seedRaw)
    : null;
  if (seed == null) return { ok: false, error: "seed is required", status: 400 };

  const resultsRaw = body.results;
  if (!isRecord(resultsRaw)) {
    return { ok: false, error: "results is required", status: 400 };
  }

  const design_id = asString(resultsRaw.design_id, 120);
  if (!design_id || !isDeskExperimentDesignId(design_id)) {
    return { ok: false, error: "results.design_id must be a desk-approaches version", status: 400 };
  }

  const manifestRaw = resultsRaw.manifest;
  if (!isRecord(manifestRaw)) {
    return { ok: false, error: "results.manifest is required", status: 400 };
  }
  const runnerVersion = typeof manifestRaw.runner_version === "number"
    && Number.isInteger(manifestRaw.runner_version)
    && manifestRaw.runner_version > 0
    ? manifestRaw.runner_version
    : null;
  const sourceRevision = asString(manifestRaw.source_revision, 120);
  const systemPrompt = asString(manifestRaw.system_prompt, 4_000);
  const systemHash = asString(manifestRaw.system_prompt_sha256, 64);
  const questionsHash = asString(manifestRaw.questions_sha256, 64);
  const designFingerprint = asString(manifestRaw.design_fingerprint_sha256, 64);
  const representationHashesRaw = manifestRaw.representation_sha256;
  const snapshotHashesRaw = isRecord(manifestRaw.snapshot_sha256)
    ? manifestRaw.snapshot_sha256
    : null;
  const executionOrderRaw = Array.isArray(manifestRaw.execution_order)
    ? manifestRaw.execution_order
    : null;
  const maxProbeAttempts = typeof manifestRaw.max_probe_attempts === "number"
    && Number.isInteger(manifestRaw.max_probe_attempts)
    && manifestRaw.max_probe_attempts >= 1
    && manifestRaw.max_probe_attempts <= 5
    ? manifestRaw.max_probe_attempts
    : null;

  if (
    runnerVersion == null
    || runnerVersion !== DESK_EXPERIMENT_RUNNER_VERSION
    || !sourceRevision
    || !systemPrompt
    || !isHash(systemHash)
    || !isHash(questionsHash)
    || !isHash(designFingerprint)
    || !isRecord(representationHashesRaw)
    || !snapshotHashesRaw
    || !executionOrderRaw
    || maxProbeAttempts == null
  ) {
    return { ok: false, error: "results.manifest is invalid or incomplete", status: 400 };
  }

  const representation_sha256: Record<string, string> = {};
  for (const [repId, hashValue] of Object.entries(representationHashesRaw)) {
    const id = asString(repId, 80);
    const hash = asString(hashValue, 64);
    if (!id || !isHash(hash)) {
      return { ok: false, error: "results.manifest representation hashes are invalid", status: 400 };
    }
    representation_sha256[id] = hash;
  }

  const snapshot_sha256: Record<string, string> = {};
  for (const [caseId, hashValue] of Object.entries(snapshotHashesRaw)) {
    const id = asString(caseId, 80);
    const hash = asString(hashValue, 64);
    if (!id || !isHash(hash)) {
      return { ok: false, error: "results.manifest snapshot hashes are invalid", status: 400 };
    }
    snapshot_sha256[id] = hash;
  }

  const execution_order = executionOrderRaw.map((item) =>
    typeof item === "string" ? item.trim().slice(0, 170) : "");
  if (execution_order.some((item) => !item)) {
    return { ok: false, error: "results.manifest execution_order is invalid", status: 400 };
  }

  const manifest: ExperimentRunManifest = {
    runner_version: runnerVersion,
    source_revision: sourceRevision,
    system_prompt: systemPrompt,
    system_prompt_sha256: systemHash,
    questions_sha256: questionsHash,
    representation_sha256,
    design_fingerprint_sha256: designFingerprint,
    execution_order,
    max_probe_attempts: maxProbeAttempts,
    snapshot_sha256,
  };

  const questionsIn = Array.isArray(resultsRaw.questions) ? resultsRaw.questions : null;
  const textRepsIn = Array.isArray(resultsRaw.text_reps) ? resultsRaw.text_reps : null;
  const cellsIn = Array.isArray(resultsRaw.cells) ? resultsRaw.cells : null;
  const orderIn = Array.isArray(resultsRaw.rep_order) ? resultsRaw.rep_order : null;
  if (!questionsIn || !textRepsIn || !cellsIn || !orderIn) {
    return { ok: false, error: "results must include questions, text_reps, cells, rep_order", status: 400 };
  }

  const questions: ExperimentRunQuestion[] = [];
  for (const q of questionsIn) {
    if (!isRecord(q)) continue;
    const id = asString(q.id, 80);
    const prompt = asString(q.prompt, 4_000);
    const expected = asString(q.expected, 500) ?? "";
    const kind = asString(q.kind, 40);
    if (!id || !prompt || !kind) continue;
    questions.push({ id, prompt, expected, kind });
  }
  if (!questions.length || questions.length !== questionsIn.length) {
    return { ok: false, error: "results.questions contains invalid entries", status: 400 };
  }

  const text_reps: ExperimentRunTextRep[] = [];
  for (const r of textRepsIn) {
    if (!isRecord(r)) continue;
    const id = asString(r.id, 80);
    const label = asString(r.label, 120);
    const description = asString(r.description, 800) ?? "";
    const bodyText = typeof r.body === "string" ? r.body : "";
    if (!id || !label || !bodyText.trim()) continue;
    text_reps.push({
      id,
      label,
      description,
      body: bodyText,
      approx_tokens: typeof r.approx_tokens === "number" && Number.isFinite(r.approx_tokens)
        ? Math.max(0, Math.trunc(r.approx_tokens))
        : undefined,
    });
  }
  if (text_reps.length !== textRepsIn.length) {
    return { ok: false, error: "results.text_reps contains invalid entries", status: 400 };
  }

  const cells: ExperimentRunCell[] = [];
  for (const c of cellsIn) {
    if (!isRecord(c)) continue;
    const rep_id = asString(c.rep_id, 80);
    const question_id = asString(c.question_id, 80);
    const status = c.status === "error" ? "error" : c.status === "done" ? "done" : null;
    if (!rep_id || !question_id || !status) continue;
    cells.push({
      rep_id,
      question_id,
      status,
      answer: typeof c.answer === "string" ? c.answer.slice(0, 8_000) : undefined,
      correct: typeof c.correct === "boolean" ? c.correct : undefined,
      detail: typeof c.detail === "string" ? c.detail.slice(0, 800) : undefined,
      latency_ms: typeof c.latency_ms === "number" && Number.isFinite(c.latency_ms)
        ? Math.max(0, Math.trunc(c.latency_ms))
        : undefined,
      error: typeof c.error === "string" ? c.error.slice(0, 1_000) : undefined,
      model: typeof c.model === "string" ? c.model.slice(0, 120) : undefined,
      attempts: typeof c.attempts === "number" && Number.isInteger(c.attempts)
        ? Math.max(1, Math.min(5, c.attempts))
        : undefined,
      lean_5d: typeof c.lean_5d === "string" ? c.lean_5d.slice(0, 16) : undefined,
      lean_20d: typeof c.lean_20d === "string" ? c.lean_20d.slice(0, 16) : undefined,
      actual_5d: typeof c.actual_5d === "string" ? c.actual_5d.slice(0, 16) : undefined,
      actual_20d: typeof c.actual_20d === "string" ? c.actual_20d.slice(0, 16) : undefined,
      correct_5d: typeof c.correct_5d === "boolean" ? c.correct_5d : undefined,
      correct_20d: typeof c.correct_20d === "boolean" ? c.correct_20d : undefined,
      session_count: typeof c.session_count === "number" && Number.isInteger(c.session_count)
        ? Math.max(0, c.session_count)
        : undefined,
    });
  }
  if (!cells.length || cells.length !== cellsIn.length) {
    return { ok: false, error: "results.cells contains invalid entries", status: 400 };
  }

  const rep_order = orderIn
    .filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
    .map((x) => x.trim().slice(0, 80));
  if (!rep_order.length) {
    return { ok: false, error: "results.rep_order must be non-empty", status: 400 };
  }

  const questionIds = new Set(questions.map((question) => question.id));
  const repIds = new Set(rep_order);
  if (questionIds.size !== questions.length) {
    return { ok: false, error: "results.questions ids must be unique", status: 400 };
  }
  if (repIds.size !== rep_order.length) {
    return { ok: false, error: "results.rep_order ids must be unique", status: 400 };
  }
  const expectedCellCount = questions.length * rep_order.length;
  if (cells.length !== expectedCellCount) {
    return {
      ok: false,
      error: `results matrix must contain exactly ${expectedCellCount} cells`,
      status: 400,
    };
  }
  const cellKeys = new Set<string>();
  for (const cell of cells) {
    const key = `${cell.rep_id}::${cell.question_id}`;
    if (!repIds.has(cell.rep_id) || !questionIds.has(cell.question_id)) {
      return { ok: false, error: `results cell ${key} is outside the declared matrix`, status: 400 };
    }
    if (cellKeys.has(key)) {
      return { ok: false, error: `results cell ${key} is duplicated`, status: 400 };
    }
    if (cell.status !== "done" || typeof cell.correct !== "boolean") {
      return { ok: false, error: `results cell ${key} is incomplete`, status: 400 };
    }
    cellKeys.add(key);
  }
  if (
    manifest.execution_order.length !== expectedCellCount
    || new Set(manifest.execution_order).size !== expectedCellCount
    || manifest.execution_order.some((key) => !cellKeys.has(key))
  ) {
    return { ok: false, error: "results.manifest execution_order must match the matrix", status: 400 };
  }
  const hashIds = Object.keys(manifest.representation_sha256);
  if (
    hashIds.length !== rep_order.length
    || hashIds.some((id) => !repIds.has(id))
    || rep_order.some((id) => !manifest.representation_sha256[id])
  ) {
    return {
      ok: false,
      error: "results.manifest must hash every declared representation exactly once",
      status: 400,
    };
  }

  const snapshotIds = Object.keys(snapshot_sha256);
  if (
    snapshotIds.length !== questions.length
    || snapshotIds.some((id) => !questionIds.has(id))
  ) {
    return { ok: false, error: "results.manifest must hash every case snapshot", status: 400 };
  }

  if (await sha256(manifest.system_prompt) !== manifest.system_prompt_sha256) {
    return { ok: false, error: "results.manifest system prompt hash does not match", status: 400 };
  }
  if (await sha256(JSON.stringify(questions)) !== manifest.questions_sha256) {
    return { ok: false, error: "results.manifest questions hash does not match", status: 400 };
  }
  const textById = new Map(text_reps.map((rep) => [rep.id, rep.body]));
  for (const repId of rep_order) {
    const body = textById.get(repId) ?? "";
    if (await sha256(body) !== manifest.representation_sha256[repId]) {
      return {
        ok: false,
        error: `results.manifest representation hash does not match for ${repId}`,
        status: 400,
      };
    }
  }

  const snapshotFingerprint = questions
    .map((q) => `${q.id}:${snapshot_sha256[q.id]}`)
    .join("\n");
  const fingerprintInput = [
    design_id,
    String(manifest.runner_version),
    manifest.system_prompt_sha256,
    manifest.questions_sha256,
    snapshotFingerprint,
    ...rep_order.map((id) => `${id}:${manifest.representation_sha256[id]}`),
  ].join("\n");
  if (await sha256(fingerprintInput) !== manifest.design_fingerprint_sha256) {
    return { ok: false, error: "results.manifest design fingerprint does not match", status: 400 };
  }

  const results: ExperimentRunResults = {
    design_id,
    manifest,
    questions,
    text_reps,
    cells,
    rep_order,
  };

  const resultsJson = JSON.stringify(results);
  if (resultsJson.length > MAX_RESULTS_CHARS) {
    return { ok: false, error: "results payload too large", status: 400 };
  }

  const created_by = typeof body.created_by === "string"
    ? body.created_by.trim().slice(0, 200) || null
    : null;

  return {
    ok: true,
    input: {
      experiment_slug: slug,
      model,
      seed,
      created_by,
      results,
      images: [],
    } satisfies SaveExperimentRunInput,
  };
}

export function deskApproachTextReps(): ExperimentRunTextRep[] {
  return DESK_APPROACHES.map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    body: `${row.id}\n${row.label}\n${row.session_mode}\n${row.description}`,
  }));
}

export { deskExperimentSystemPrompt };
