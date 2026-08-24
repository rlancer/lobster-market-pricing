/**
 * Persist and load published experiment runs (results + LLM-fed images).
 */

export const MAX_EXPERIMENT_RESULTS_CHARS = 400_000;
export const MAX_EXPERIMENT_IMAGE_DATA_URL_CHARS = 1_800_000;
export const MAX_EXPERIMENT_IMAGES = 12;

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
}

export interface ExperimentRunQuestion {
  id: string;
  prompt: string;
  expected: string;
}

export interface ExperimentRunTextRep {
  id: string;
  label: string;
  description: string;
  approx_tokens?: number;
  body: string;
}

/** JSON stored in experiment_runs.results_json (no image blobs). */
export interface ExperimentRunResults {
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

export function parseSaveExperimentRunBody(
  body: unknown,
  slugFromPath: string,
): ParseSaveResult {
  if (!isRecord(body)) {
    return { ok: false, error: "JSON body required", status: 400 };
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
    if (!id || !prompt) continue;
    questions.push({ id, prompt, expected });
  }
  if (!questions.length) {
    return { ok: false, error: "results.questions must be non-empty", status: 400 };
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
    });
  }
  if (!cells.length) {
    return { ok: false, error: "results.cells must be non-empty", status: 400 };
  }

  const rep_order = orderIn
    .filter((x): x is string => typeof x === "string" && Boolean(x.trim()))
    .map((x) => x.trim().slice(0, 80));
  if (!rep_order.length) {
    return { ok: false, error: "results.rep_order must be non-empty", status: 400 };
  }

  const results: ExperimentRunResults = { questions, text_reps, cells, rep_order };
  const resultsJson = JSON.stringify(results);
  if (resultsJson.length > MAX_EXPERIMENT_RESULTS_CHARS) {
    return { ok: false, error: "results payload too large", status: 400 };
  }

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
): Promise<ExperimentRunRecord | null> {
  const row = await db.prepare(
    `SELECT id, experiment_slug, model, seed, created_at, created_by, results_json
     FROM experiment_runs
     WHERE experiment_slug = ?1
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(experimentSlug).first<{
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

/** Public JSON shape for GET latest. */
export function experimentRunToPublicJson(run: ExperimentRunRecord) {
  return {
    id: run.id,
    experiment_slug: run.experiment_slug,
    model: run.model,
    seed: run.seed,
    created_at: run.created_at,
    created_by: run.created_by,
    results: run.results,
    images: run.images.map((img) => ({
      id: img.id,
      label: img.label,
      description: img.description,
      width: img.width,
      height: img.height,
      data_url: img.data_url,
    })),
  };
}
