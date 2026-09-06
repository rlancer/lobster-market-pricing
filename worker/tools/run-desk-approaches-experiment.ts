/**
 * Run the desk-approaches matrix in-process (OpenRouter from this job), then
 * publish via the Worker admin API.
 *
 * 5-seat cells cannot finish inside one Worker HTTP request — DeepSeek seats
 * are 1–4 minutes each. GitHub Actions has a 3h budget; the Worker does not.
 *
 * Env: ADMIN_TOKEN, OPEN_ROUTER_KEY, API_BASE, MODEL, COPILOT_REASONING_EFFORT,
 * COPILOT_MAX_OUTPUT_TOKENS
 */
import { createHash } from "node:crypto";
import {
  DESK_EXPERIMENT_RUNNER_VERSION,
  caseById,
  runDeskApproach,
  scoreDeskVerdict,
  type DeskApproachId,
} from "../src/desk-experiment.ts";
import { buildDeskExperimentCases } from "../src/desk-experiment-cases.ts";
import {
  createDeskCompleteFn,
  resolveDeskExperimentModel,
  type DeskExperimentProbeEnv,
} from "../src/desk-experiment-probe.ts";

const API_BASE = (process.env.API_BASE?.trim() || "https://api-dev.lobster.mp").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const OPEN_ROUTER_KEY = process.env.OPEN_ROUTER_KEY ?? "";
const MODEL = process.env.MODEL?.trim() || "deepseek/deepseek-v4-flash-0731";
const SLUG = "desk-approaches";
const DESIGN_ID = "desk-approaches-v1";
const RUNNER_VERSION = DESK_EXPERIMENT_RUNNER_VERSION;
const PROBE_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.PROBE_ATTEMPTS ?? 2) || 2));
const SOURCE_REVISION = process.env.GITHUB_SHA?.trim()
  || process.env.SOURCE_REVISION?.trim()
  || "local";

if (!ADMIN_TOKEN) {
  console.error("ADMIN_TOKEN is required");
  process.exit(1);
}
if (!OPEN_ROUTER_KEY.trim()) {
  console.error("OPEN_ROUTER_KEY is required for in-process seats");
  process.exit(1);
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Cell {
  rep_id: string;
  question_id: string;
  status: "done";
  answer: string;
  correct: boolean;
  detail: string;
  latency_ms?: number;
  model: string;
  attempts: number;
  lean_5d?: string;
  lean_20d?: string;
  actual_5d?: string;
  actual_20d?: string;
  correct_5d?: boolean;
  correct_20d?: boolean;
  session_count: number;
}

async function api(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text.slice(0, 400)}`);
  }
  return json as Record<string, unknown>;
}

async function main() {
  const design = await api("/api/experiments/desk-approaches/design") as {
    design_id: string;
    as_of_rules: string;
    model?: string;
    approaches: Array<{ id: string; label: string; description: string; session_mode: string }>;
    cases: Array<{
      id: string;
      prompt: string;
      expected_5d: string;
      expected_20d: string;
      snapshot_text: string;
    }>;
  };
  if (design.design_id !== DESIGN_ID) {
    throw new Error(`unexpected design_id ${design.design_id}`);
  }

  const modelId = resolveDeskExperimentModel(
    { COPILOT_MODEL: design.model || MODEL },
    MODEL,
  );
  const env: DeskExperimentProbeEnv = {
    OPEN_ROUTER_KEY,
    COPILOT_MODEL: modelId,
    COPILOT_REASONING_EFFORT: process.env.COPILOT_REASONING_EFFORT || "high",
    COPILOT_MAX_OUTPUT_TOKENS: process.env.COPILOT_MAX_OUTPUT_TOKENS || "8192",
  };
  const complete = createDeskCompleteFn(env, API_BASE, modelId);
  const localCases = buildDeskExperimentCases();

  const systemPrompt = [
    design.as_of_rules,
    "End with a JSON verdict of lean_5d / lean_20d.",
    "Approaches differ only in session structure (solo / role-play desk / shared session / fresh sessions).",
  ].join("\n");
  const questions = design.cases.map((row) => ({
    id: row.id,
    prompt: row.prompt,
    expected: `5d=${row.expected_5d},20d=${row.expected_20d}`,
    kind: "direction",
  }));
  const textReps = design.approaches.map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    body: `${row.id}\n${row.label}\n${row.session_mode}\n${row.description}`,
  }));
  const repOrder = textReps.map((row) => row.id);
  const representationHashes = Object.fromEntries(textReps.map((row) => [row.id, sha256(row.body)]));
  const snapshotHashes = Object.fromEntries(
    design.cases.map((row) => [row.id, sha256(row.snapshot_text)]),
  );
  const executionOrder: string[] = [];
  for (const approach of design.approaches) {
    for (const experimentCase of design.cases) {
      executionOrder.push(`${approach.id}::${experimentCase.id}`);
    }
  }
  const cells: Cell[] = [];

  const fillMissing = (reason: string) => {
    const have = new Set(cells.map((cell) => `${cell.rep_id}::${cell.question_id}`));
    for (const key of executionOrder) {
      if (have.has(key)) continue;
      const [repId, questionId] = key.split("::");
      cells.push({
        rep_id: repId!,
        question_id: questionId!,
        status: "done",
        answer: "[no answer]",
        correct: false,
        detail: reason.slice(0, 500),
        model: modelId,
        attempts: PROBE_ATTEMPTS,
        session_count: repId === "desk_fresh_sessions" ? 5 : 1,
      });
    }
  };

  const payload = () => {
    fillMissing("incomplete — runner stopped before this cell");
    const snapshotFingerprint = questions
      .map((q) => `${q.id}:${snapshotHashes[q.id]}`)
      .join("\n");
    const fingerprint = sha256([
      DESIGN_ID,
      String(RUNNER_VERSION),
      sha256(systemPrompt),
      sha256(JSON.stringify(questions)),
      snapshotFingerprint,
      ...repOrder.map((id) => `${id}:${representationHashes[id]}`),
    ].join("\n"));
    return {
      experiment_slug: SLUG,
      model: modelId,
      seed: 0x4d45534b,
      results: {
        design_id: DESIGN_ID,
        manifest: {
          runner_version: RUNNER_VERSION,
          source_revision: SOURCE_REVISION,
          system_prompt: systemPrompt,
          system_prompt_sha256: sha256(systemPrompt),
          questions_sha256: sha256(JSON.stringify(questions)),
          representation_sha256: representationHashes,
          snapshot_sha256: snapshotHashes,
          design_fingerprint_sha256: fingerprint,
          execution_order: executionOrder,
          max_probe_attempts: PROBE_ATTEMPTS,
        },
        questions,
        text_reps: textReps,
        cells,
        rep_order: repOrder,
      },
      images: [],
    };
  };

  let published = false;
  const publish = async (label: string) => {
    if (published) return;
    published = true;
    const saved = await api(`/api/admin/experiments/${SLUG}/runs`, {
      method: "POST",
      body: payload(),
    });
    const run = saved.run as { id?: string } | undefined;
    console.log(label, run?.id ?? saved);
  };

  process.on("SIGTERM", () => {
    void publish("saved-on-sigterm").finally(() => process.exit(1));
  });
  process.on("SIGINT", () => {
    void publish("saved-on-sigint").finally(() => process.exit(1));
  });

  for (const approach of design.approaches) {
    for (const experimentCase of design.cases) {
      const key = `${approach.id}::${experimentCase.id}`;
      process.stdout.write(`probe ${key}… `);
      const local = caseById(experimentCase.id, localCases);
      if (!local) throw new Error(`unknown case ${experimentCase.id}`);
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
        try {
          const run = await runDeskApproach(approach.id as DeskApproachId, local, complete);
          const score = scoreDeskVerdict(run.verdict, local);
          cells.push({
            rep_id: approach.id,
            question_id: experimentCase.id,
            status: "done",
            answer: (run.answer ?? "").slice(0, 4000),
            correct: Boolean(score.correct),
            detail: score.detail,
            latency_ms: run.latency_ms,
            model: modelId,
            attempts: attempt,
            lean_5d: run.verdict?.lean_5d,
            lean_20d: run.verdict?.lean_20d,
            actual_5d: score.actual_5d,
            actual_20d: score.actual_20d,
            correct_5d: score.correct_5d,
            correct_20d: score.correct_20d,
            session_count: run.session_count,
          });
          console.log(
            score.correct ? "ok" : "miss",
            `(sessions=${run.session_count}, ${run.latency_ms}ms, attempt ${attempt})`,
          );
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= PROBE_ATTEMPTS) break;
          const delay = 4_000 * attempt;
          process.stdout.write(`retry ${attempt}/${PROBE_ATTEMPTS} in ${delay}ms… `);
          await sleep(delay);
        }
      }
      if (lastError) {
        cells.push({
          rep_id: approach.id,
          question_id: experimentCase.id,
          status: "done",
          answer: "[no answer]",
          correct: false,
          detail: String((lastError as Error).message ?? lastError).slice(0, 500),
          model: modelId,
          attempts: PROBE_ATTEMPTS,
          session_count: approach.id === "desk_fresh_sessions" ? 5 : 1,
        });
        console.log("fail", (lastError as Error).message ?? lastError);
      }
    }
  }

  await publish("saved");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
