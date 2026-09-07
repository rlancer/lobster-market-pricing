import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseSaveExperimentRunBody } from "../src/experiment-runs.ts";
import { deskApproachTextReps } from "../src/desk-experiment-save.ts";
import {
  DESK_EXPERIMENT_DESIGN_ID,
  DESK_EXPERIMENT_RUNNER_VERSION,
  deskExperimentSystemPrompt,
} from "../src/desk-experiment.ts";
import { buildDeskExperimentCases, formatDeskSnapshot } from "../src/desk-experiment-cases.ts";
import { leanFromReturn } from "../src/desk-experiment.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("parseSaveExperimentRunBody accepts a desk-approaches run without images", async () => {
  const cases = buildDeskExperimentCases();
  const systemPrompt = deskExperimentSystemPrompt();
  const reps = deskApproachTextReps();
  const questions = cases.map((row) => ({
    id: row.id,
    prompt: row.prompt,
    expected: `5d=${leanFromReturn(row.outcome.return_5d_pct)},20d=${leanFromReturn(row.outcome.return_20d_pct)}`,
    kind: "direction",
  }));
  const repOrder = reps.map((r) => r.id);
  const representationHashes = Object.fromEntries(reps.map((r) => [r.id, sha256(r.body)]));
  const snapshotHashes = Object.fromEntries(
    cases.map((row) => [row.id, sha256(formatDeskSnapshot(row.snapshot))]),
  );
  const executionOrder = [];
  const cells = [];
  for (const rep of reps) {
    for (const q of questions) {
      executionOrder.push(`${rep.id}::${q.id}`);
      cells.push({
        rep_id: rep.id,
        question_id: q.id,
        status: "done" as const,
        answer: "lean",
        correct: true,
        lean_5d: "bearish",
        lean_20d: "bearish",
        session_count: rep.id === "desk_fresh_sessions" ? 5 : 1,
      });
    }
  }
  const snapshotFingerprint = questions.map((q) => `${q.id}:${snapshotHashes[q.id]}`).join("\n");
  const fingerprint = sha256([
    DESK_EXPERIMENT_DESIGN_ID,
    String(DESK_EXPERIMENT_RUNNER_VERSION),
    sha256(systemPrompt),
    sha256(JSON.stringify(questions)),
    snapshotFingerprint,
    ...repOrder.map((id) => `${id}:${representationHashes[id]}`),
  ].join("\n"));

  const parsed = await parseSaveExperimentRunBody({
    experiment_slug: "desk-approaches",
    model: "deepseek/deepseek-v4-flash-0731",
    seed: 0x4d45534b,
    results: {
      design_id: DESK_EXPERIMENT_DESIGN_ID,
      manifest: {
        runner_version: DESK_EXPERIMENT_RUNNER_VERSION,
        source_revision: "test",
        system_prompt: systemPrompt,
        system_prompt_sha256: sha256(systemPrompt),
        questions_sha256: sha256(JSON.stringify(questions)),
        representation_sha256: representationHashes,
        snapshot_sha256: snapshotHashes,
        design_fingerprint_sha256: fingerprint,
        execution_order: executionOrder,
        max_probe_attempts: 2,
      },
      questions,
      text_reps: reps,
      cells,
      rep_order: repOrder,
    },
    images: [],
  }, "desk-approaches");

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.input.images.length, 0);
  assert.equal(parsed.input.results.cells.length, 16);
  assert.equal(parsed.input.results.cells[0]?.session_count, 1);
  const fresh = parsed.input.results.cells.find((c) => c.rep_id === "desk_fresh_sessions");
  assert.equal(fresh?.session_count, 5);
});

test("parseSaveExperimentRunBody still requires images for text-vs-image", async () => {
  const parsed = await parseSaveExperimentRunBody({
    experiment_slug: "text-vs-image",
    model: "m",
    seed: 1,
    results: {
      design_id: "text-vs-image-v3",
      manifest: {},
      questions: [],
      text_reps: [],
      cells: [],
      rep_order: [],
    },
    images: [],
  }, "text-vs-image");
  assert.equal(parsed.ok, false);
});
