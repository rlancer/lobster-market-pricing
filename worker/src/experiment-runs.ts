/**
 * Persist and load published experiment runs (results + LLM-fed images).
 */

export const MAX_EXPERIMENT_RESULTS_CHARS = 400_000;
export const MAX_EXPERIMENT_IMAGE_DATA_URL_CHARS = 1_800_000;
export const MAX_EXPERIMENT_IMAGES = 12;
export const EXPERIMENT_RUN_SCHEMA_VERSION = 2;

export interface ExperimentRunImage {
  id: string;
  label: string;
  description: string;
  width: number;
  height: number;
  data_url: string;
}

export interface ExperimentRunCell {
  rep_id: string;
  question_id: string;
  status: "done" | "error";
  answer?: string;
  correct?: boolean;
  detail?: string;
  latency_ms?: number;
  error?: string;
  model?: string;
  attempts?: number;
  /** Desk-approaches cells: directional lean vs held-out as-of outcome. */
  lean_5d?: string;
  lean_20d?: string;
  actual_5d?: string;
  actual_20d?: string;
  correct_5d?: boolean;
  correct_20d?: boolean;
  session_count?: number;
}

export interface ExperimentRunQuestion {
  id: string;
  prompt: string;
  expected: string;
  kind: string;
}

export interface ExperimentRunTextRep {
  id: string;
  label: string;
  description: string;
  approx_tokens?: number;
  body: string;
}

export interface ExperimentRunManifest {
  runner_version: number;
  source_revision: string;
  system_prompt: string;
  system_prompt_sha256: string;
  questions_sha256: string;
  representation_sha256: Record<string, string>;
  design_fingerprint_sha256: string;
  execution_order: string[];
  max_probe_attempts: number;
  /** Desk-approaches: sha256 of each frozen as-of snapshot (keyed by case id). */
  snapshot_sha256?: Record<string, string>;
}

/** JSON stored in experiment_runs.results_json (no image blobs). */
export interface ExperimentRunResults {
  design_id: string;
  manifest: ExperimentRunManifest;
  questions: ExperimentRunQuestion[];
  text_reps: ExperimentRunTextRep[];
  cells: ExperimentRunCell[];
  rep_order: string[];
}

export interface ExperimentRunRecord {
  id: string;
  experiment_slug: string;
  model: string;
  seed: number;
  created_at: number;
  created_by: string | null;
  results: ExperimentRunResults;
  images: ExperimentRunImage[];
}

export interface SaveExperimentRunInput {
  experiment_slug: string;
  model: string;
  seed: number;
  created_by?: string | null;
  results: ExperimentRunResults;
  images: ExperimentRunImage[];
}

export type ParseSaveResult =
  | { ok: true; input: SaveExperimentRunInput }
  | { ok: false; error: string; status: number };

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

export async function parseSaveExperimentRunBody(
  body: unknown,
  slugFromPath: string,
): Promise<ParseSaveResult> {
  if (!isRecord(body)) {
    return { ok: false, error: "JSON body required", status: 400 };
  }

  if (isRecord(body.results) && typeof body.results.design_id === "string"
    && body.results.design_id.startsWith("desk-approaches")) {
    const { parseSaveDeskExperimentRunBody } = await import("./desk-experiment-save");
    return parseSaveDeskExperimentRunBody(body, slugFromPath);
  }

  const slug = asString(body.experiment_slug, 80) ?? slugFromPath;
  if (slug !== slugFromPath) {
    return { ok: false, error: "experiment_slug must match path", status: 400 };
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    return { ok: false, error: "invalid experiment_slug", status: 400 };
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
  if (!design_id || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(design_id)) {
    return { ok: false, error: "results.design_id is required and must be versioned", status: 400 };
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
  const executionOrderRaw = Array.isArray(manifestRaw.execution_order)
    ? manifestRaw.execution_order
    : null;
  const maxProbeAttempts = typeof manifestRaw.max_probe_attempts === "number"
    && Number.isInteger(manifestRaw.max_probe_attempts)
    && manifestRaw.max_probe_attempts >= 1
    && manifestRaw.max_probe_attempts <= 5
    ? manifestRaw.max_probe_attempts
    : null;
  const isHash = (value: string | null): value is string =>
    Boolean(value && /^[a-f0-9]{64}$/.test(value));
  if (
    runnerVersion == null
    || !sourceRevision
    || !systemPrompt
    || !isHash(systemHash)
    || !isHash(questionsHash)
    || !isHash(designFingerprint)
    || !isRecord(representationHashesRaw)
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
  if (!questions.length) {
    return { ok: false, error: "results.questions must be non-empty", status: 400 };
  }
  if (questions.length !== questionsIn.length) {
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
    if (bodyText.length > 120_000) {
      return { ok: false, error: `text_rep ${id} body too large`, status: 400 };
    }
    const approx = typeof r.approx_tokens === "number" && Number.isFinite(r.approx_tokens)
      ? Math.max(0, Math.trunc(r.approx_tokens))
      : undefined;
    text_reps.push({ id, label, description, approx_tokens: approx, body: bodyText });
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
      answer: typeof c.answer === "string" ? c.answer.slice(0, 4_000) : undefined,
      correct: typeof c.correct === "boolean" ? c.correct : undefined,
      detail: typeof c.detail === "string" ? c.detail.slice(0, 500) : undefined,
      latency_ms: typeof c.latency_ms === "number" && Number.isFinite(c.latency_ms)
        ? Math.max(0, Math.trunc(c.latency_ms))
        : undefined,
      error: typeof c.error === "string" ? c.error.slice(0, 1_000) : undefined,
      model: typeof c.model === "string" ? c.model.slice(0, 120) : undefined,
      attempts: typeof c.attempts === "number" && Number.isInteger(c.attempts)
        ? Math.max(1, Math.min(5, c.attempts))
        : undefined,
    });
  }
  if (!cells.length) {
    return { ok: false, error: "results.cells must be non-empty", status: 400 };
  }
  if (cells.length !== cellsIn.length) {
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

  const results: ExperimentRunResults = {
    design_id,
    manifest,
    questions,
    text_reps,
    cells,
    rep_order,
  };

  const imagesIn = Array.isArray(body.images) ? body.images : null;
  if (!imagesIn || !imagesIn.length) {
    return { ok: false, error: "images is required (exact PNGs fed to the model)", status: 400 };
  }
  if (imagesIn.length > MAX_EXPERIMENT_IMAGES) {
    return { ok: false, error: "too many images", status: 400 };
  }

  const images: ExperimentRunImage[] = [];
  for (const img of imagesIn) {
    if (!isRecord(img)) continue;
    const id = asString(img.id, 80);
    const label = asString(img.label, 120);
    const description = asString(img.description, 800) ?? "";
    const data_url = typeof img.data_url === "string" ? img.data_url : "";
    const width = typeof img.width === "number" && Number.isFinite(img.width)
      ? Math.trunc(img.width)
      : 0;
    const height = typeof img.height === "number" && Number.isFinite(img.height)
      ? Math.trunc(img.height)
      : 0;
    if (!id || !label) continue;
    if (!data_url.startsWith("data:image/")) {
      return { ok: false, error: `image ${id}: data_url must be data:image/...`, status: 400 };
    }
    if (data_url.length > MAX_EXPERIMENT_IMAGE_DATA_URL_CHARS) {
      return { ok: false, error: `image ${id}: data_url too large`, status: 400 };
    }
    if (width <= 0 || height <= 0) {
      return { ok: false, error: `image ${id}: width/height required`, status: 400 };
    }
    images.push({ id, label, description, width, height, data_url });
  }
  if (!images.length) {
    return { ok: false, error: "images must be non-empty", status: 400 };
  }
  if (images.length !== imagesIn.length) {
    return { ok: false, error: "images contains invalid entries", status: 400 };
  }
  const textRepIds = new Set(text_reps.map((rep) => rep.id));
  const imageIds = new Set(images.map((image) => image.id));
  if (textRepIds.size !== text_reps.length || imageIds.size !== images.length) {
    return { ok: false, error: "representation ids must be unique within each payload type", status: 400 };
  }
  if (
    rep_order.some((id) => !textRepIds.has(id) && !imageIds.has(id))
    || [...textRepIds, ...imageIds].some((id) => !repIds.has(id))
  ) {
    return {
      ok: false,
      error: "representation payloads must match results.rep_order",
      status: 400,
    };
  }

  if (await sha256(manifest.system_prompt) !== manifest.system_prompt_sha256) {
    return { ok: false, error: "results.manifest system prompt hash does not match", status: 400 };
  }
  if (await sha256(JSON.stringify(questions)) !== manifest.questions_sha256) {
    return { ok: false, error: "results.manifest questions hash does not match", status: 400 };
  }
  const textById = new Map(text_reps.map((rep) => [rep.id, rep.body]));
  const imageById = new Map(images.map((image) => [image.id, image.data_url]));
  for (const repId of rep_order) {
    const text = textById.get(repId);
    const image = imageById.get(repId);
    const content = text != null && image != null
      ? `${text}\n${image}`
      : text ?? image ?? "";
    if (await sha256(content) !== manifest.representation_sha256[repId]) {
      return {
        ok: false,
        error: `results.manifest representation hash does not match for ${repId}`,
        status: 400,
      };
    }
  }
  const fingerprintInput = [
    design_id,
    String(manifest.runner_version),
    manifest.system_prompt_sha256,
    manifest.questions_sha256,
    ...rep_order.map((id) => `${id}:${manifest.representation_sha256[id]}`),
  ].join("\n");
  if (await sha256(fingerprintInput) !== manifest.design_fingerprint_sha256) {
    return { ok: false, error: "results.manifest design fingerprint does not match", status: 400 };
  }

  const resultsJson = JSON.stringify(results);
  if (resultsJson.length > MAX_EXPERIMENT_RESULTS_CHARS) {
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
      images,
    },
  };
}

export async function saveExperimentRun(
  db: D1Database,
  input: SaveExperimentRunInput,
): Promise<ExperimentRunRecord> {
  const id = crypto.randomUUID();
  const created_at = Date.now();
  const results_json = JSON.stringify(input.results);

  await db.batch([
    db.prepare(
      `INSERT INTO experiment_runs
        (id, experiment_slug, model, seed, created_at, created_by, results_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      id,
      input.experiment_slug,
      input.model,
      input.seed,
      created_at,
      input.created_by ?? null,
      results_json,
    ),
    ...input.images.map((img) =>
      db.prepare(
        `INSERT INTO experiment_run_images
          (run_id, image_id, label, description, width, height, data_url)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(
        id,
        img.id,
        img.label,
        img.description,
        img.width,
        img.height,
        img.data_url,
      )
    ),
  ]);

  return {
    id,
    experiment_slug: input.experiment_slug,
    model: input.model,
    seed: input.seed,
    created_at,
    created_by: input.created_by ?? null,
    results: input.results,
    images: input.images,
  };
}

export async function getLatestExperimentRun(
  db: D1Database,
  experimentSlug: string,
  designId?: string,
): Promise<ExperimentRunRecord | null> {
  const row = await db.prepare(
    `SELECT id, experiment_slug, model, seed, created_at, created_by, results_json
     FROM experiment_runs
     WHERE experiment_slug = ?1
       AND (?2 IS NULL OR json_extract(results_json, '$.design_id') = ?2)
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(experimentSlug, designId ?? null).first<{
    id: string;
    experiment_slug: string;
    model: string;
    seed: number;
    created_at: number;
    created_by: string | null;
    results_json: string;
  }>();

  if (!row) return null;

  let results: ExperimentRunResults;
  try {
    results = JSON.parse(row.results_json) as ExperimentRunResults;
  } catch {
    return null;
  }

  const imageRows = await db.prepare(
    `SELECT image_id, label, description, width, height, data_url
     FROM experiment_run_images
     WHERE run_id = ?1
     ORDER BY image_id ASC`,
  ).bind(row.id).all<{
    image_id: string;
    label: string;
    description: string;
    width: number;
    height: number;
    data_url: string;
  }>();

  const images: ExperimentRunImage[] = (imageRows.results ?? []).map((r) => ({
    id: r.image_id,
    label: r.label,
    description: r.description,
    width: r.width,
    height: r.height,
    data_url: r.data_url,
  }));

  return {
    id: row.id,
    experiment_slug: row.experiment_slug,
    model: row.model,
    seed: row.seed,
    created_at: row.created_at,
    created_by: row.created_by,
    results,
    images,
  };
}

/** Public JSON shape for GET latest / GET by id. */
export function experimentRunToPublicJson(
  run: ExperimentRunRecord,
  opts?: { omitImages?: boolean },
) {
  return {
    id: run.id,
    experiment_slug: run.experiment_slug,
    model: run.model,
    seed: run.seed,
    created_at: run.created_at,
    created_by: run.created_by,
    results: run.results,
    images: opts?.omitImages
      ? []
      : run.images.map((img) => ({
          id: img.id,
          label: img.label,
          description: img.description,
          width: img.width,
          height: img.height,
          data_url: img.data_url,
        })),
  };
}

export interface ExperimentRunRepAccuracy {
  rep_id: string;
  correct: number;
  done: number;
}

export interface ExperimentRunSummary {
  id: string;
  experiment_slug: string;
  model: string;
  seed: number;
  created_at: number;
  created_by: string | null;
  design_id: string | null;
  manifest_fingerprint: string | null;
  matrix_complete: boolean;
  cells_done: number;
  cells_correct: number;
  cells_total: number;
  /** Per-representation accuracy for cross-model conclusions (no image blobs). */
  rep_accuracy: ExperimentRunRepAccuracy[];
  rep_order: string[];
}

function summarizeResultsJson(resultsJson: string): {
  design_id: string | null;
  manifest_fingerprint: string | null;
  matrix_complete: boolean;
  cells_done: number;
  cells_correct: number;
  cells_total: number;
  rep_accuracy: ExperimentRunRepAccuracy[];
  rep_order: string[];
} {
  try {
    const results = JSON.parse(resultsJson) as ExperimentRunResults;
    const design_id = typeof results.design_id === "string" ? results.design_id : null;
    const manifest_fingerprint =
      typeof results.manifest?.design_fingerprint_sha256 === "string"
        ? results.manifest.design_fingerprint_sha256
        : null;
    const questions = Array.isArray(results.questions) ? results.questions : [];
    const cells = Array.isArray(results.cells) ? results.cells : [];
    const done = cells.filter((c) => c.status === "done");
    const byRep = new Map<string, { correct: number; done: number }>();
    for (const cell of done) {
      const cur = byRep.get(cell.rep_id) ?? { correct: 0, done: 0 };
      cur.done += 1;
      if (cell.correct) cur.correct += 1;
      byRep.set(cell.rep_id, cur);
    }
    const rep_order = Array.isArray(results.rep_order)
      ? results.rep_order.filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
      : [...byRep.keys()];
    const rep_accuracy: ExperimentRunRepAccuracy[] = [];
    const seen = new Set<string>();
    for (const rid of rep_order) {
      if (seen.has(rid)) continue;
      seen.add(rid);
      const stats = byRep.get(rid) ?? { correct: 0, done: 0 };
      rep_accuracy.push({ rep_id: rid, correct: stats.correct, done: stats.done });
    }
    for (const [rid, stats] of byRep) {
      if (seen.has(rid)) continue;
      rep_accuracy.push({ rep_id: rid, correct: stats.correct, done: stats.done });
    }
    const expectedKeys = new Set<string>();
    for (const repId of rep_order) {
      for (const question of questions) expectedKeys.add(`${repId}::${question.id}`);
    }
    const actualKeys = new Set(cells.map((cell) => `${cell.rep_id}::${cell.question_id}`));
    const matrix_complete = expectedKeys.size > 0
      && cells.length === expectedKeys.size
      && actualKeys.size === expectedKeys.size
      && cells.every((cell) =>
        cell.status === "done"
        && typeof cell.correct === "boolean"
        && expectedKeys.has(`${cell.rep_id}::${cell.question_id}`));
    return {
      design_id,
      manifest_fingerprint,
      matrix_complete,
      cells_total: cells.length,
      cells_done: done.length,
      cells_correct: done.filter((c) => c.correct).length,
      rep_accuracy,
      rep_order,
    };
  } catch {
    return {
      design_id: null,
      manifest_fingerprint: null,
      matrix_complete: false,
      cells_total: 0,
      cells_done: 0,
      cells_correct: 0,
      rep_accuracy: [],
      rep_order: [],
    };
  }
}

/** Exported for unit tests — parse results_json into list-summary fields. */
export function summarizeExperimentResultsJson(resultsJson: string): {
  design_id: string | null;
  manifest_fingerprint: string | null;
  matrix_complete: boolean;
  cells_done: number;
  cells_correct: number;
  cells_total: number;
  rep_accuracy: ExperimentRunRepAccuracy[];
  rep_order: string[];
} {
  return summarizeResultsJson(resultsJson);
}

/** List published runs (newest first) without image blobs — for model comparison. */
export async function listExperimentRuns(
  db: D1Database,
  experimentSlug: string,
  limit = 20,
  designId?: string,
): Promise<ExperimentRunSummary[]> {
  const capped = Math.max(1, Math.min(50, Math.trunc(limit)));
  const rows = await db.prepare(
    `SELECT id, experiment_slug, model, seed, created_at, created_by, results_json
     FROM experiment_runs
     WHERE experiment_slug = ?1
       AND (?2 IS NULL OR json_extract(results_json, '$.design_id') = ?2)
     ORDER BY created_at DESC
     LIMIT ?3`,
  ).bind(experimentSlug, designId ?? null, capped).all<{
    id: string;
    experiment_slug: string;
    model: string;
    seed: number;
    created_at: number;
    created_by: string | null;
    results_json: string;
  }>();

  return (rows.results ?? []).map((row) => {
    const stats = summarizeResultsJson(row.results_json);
    return {
      id: row.id,
      experiment_slug: row.experiment_slug,
      model: row.model,
      seed: row.seed,
      created_at: row.created_at,
      created_by: row.created_by,
      ...stats,
    };
  });
}

export async function getExperimentRunById(
  db: D1Database,
  experimentSlug: string,
  runId: string,
  designId?: string,
): Promise<ExperimentRunRecord | null> {
  const row = await db.prepare(
    `SELECT id, experiment_slug, model, seed, created_at, created_by, results_json
     FROM experiment_runs
     WHERE experiment_slug = ?1 AND id = ?2
       AND (?3 IS NULL OR json_extract(results_json, '$.design_id') = ?3)
     LIMIT 1`,
  ).bind(experimentSlug, runId, designId ?? null).first<{
    id: string;
    experiment_slug: string;
    model: string;
    seed: number;
    created_at: number;
    created_by: string | null;
    results_json: string;
  }>();

  if (!row) return null;

  let results: ExperimentRunResults;
  try {
    results = JSON.parse(row.results_json) as ExperimentRunResults;
  } catch {
    return null;
  }

  const imageRows = await db.prepare(
    `SELECT image_id, label, description, width, height, data_url
     FROM experiment_run_images
     WHERE run_id = ?1
     ORDER BY image_id ASC`,
  ).bind(row.id).all<{
    image_id: string;
    label: string;
    description: string;
    width: number;
    height: number;
    data_url: string;
  }>();

  return {
    id: row.id,
    experiment_slug: row.experiment_slug,
    model: row.model,
    seed: row.seed,
    created_at: row.created_at,
    created_by: row.created_by,
    results,
    images: (imageRows.results ?? []).map((r) => ({
      id: r.image_id,
      label: r.label,
      description: r.description,
      width: r.width,
      height: r.height,
      data_url: r.data_url,
    })),
  };
}
