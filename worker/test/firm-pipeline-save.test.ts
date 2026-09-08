import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseSaveExperimentRunBody } from "../src/experiment-runs.ts";
import { leanFromReturn } from "../src/desk-experiment.ts";
import { buildDeskExperimentCases, formatDeskSnapshot } from "../src/desk-experiment-cases.ts";
import {
  FIRM_PIPELINE_DESIGN_ID,
  FIRM_PIPELINE_RUNNER_VERSION,
  firmPipelineSystemPrompt,
  firmPipelineTextReps,
} from "../src/firm-pipeline.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("parseSaveExperimentRunBody accepts a firm-pipeline run without images", async () => {
  const cases = buildDeskExperimentCases();
  const systemPrompt = firmPipelineSystemPrompt();
  const reps = firmPipelineTextReps();
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
        session_count: rep.id === "solo" ? 1 : 7,
      });
    }
  }
  const snapshotFingerprint = questions.map((q) => `${q.id}:${snapshotHashes[q.id]}`).join("\n");
  const fingerprint = sha256([
    FIRM_PIPELINE_DESIGN_ID,
    String(FIRM_PIPELINE_RUNNER_VERSION),
    sha256(systemPrompt),
    sha256(JSON.stringify(questions)),
    snapshotFingerprint,
    ...repOrder.map((id) => `${id}:${representationHashes[id]}`),
  ].join("\n"));

  const parsed = await parseSaveExperimentRunBody({
    experiment_slug: "firm-pipeline",
    model: "deepseek/deepseek-v4-flash-0731",
    seed: 0x4d45534b,
    results: {
      design_id: FIRM_PIPELINE_DESIGN_ID,
      manifest: {
        runner_version: FIRM_PIPELINE_RUNNER_VERSION,
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
  }, "firm-pipeline");

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.input.images.length, 0);
  assert.equal(parsed.input.results.cells.length, 16);
  assert.equal(parsed.input.experiment_slug, "firm-pipeline");
  assert.equal(parsed.input.results.design_id, FIRM_PIPELINE_DESIGN_ID);
});

test("parseSaveExperimentRunBody rejects a firm-pipeline run with the desk runner version", async () => {
  const parsed = await parseSaveExperimentRunBody({
    experiment_slug: "firm-pipeline",
    model: "m",
    seed: 1,
    results: {
      design_id: FIRM_PIPELINE_DESIGN_ID,
      manifest: {
        runner_version: 2,
        source_revision: "test",
        system_prompt: "x",
        system_prompt_sha256: "a".repeat(64),
        questions_sha256: "b".repeat(64),
        representation_sha256: { solo: "c".repeat(64) },
        snapshot_sha256: { "drift-breakdown": "d".repeat(64) },
        design_fingerprint_sha256: "e".repeat(64),
        execution_order: ["solo::drift-breakdown"],
        max_probe_attempts: 1,
      },
      questions: [{ id: "drift-breakdown", prompt: "p", expected: "e", kind: "direction" }],
      text_reps: [{ id: "solo", label: "Solo", description: "d", body: "b" }],
      cells: [{
        rep_id: "solo",
        question_id: "drift-breakdown",
        status: "done",
        correct: true,
      }],
      rep_order: ["solo"],
    },
    images: [],
  }, "firm-pipeline");
  assert.equal(parsed.ok, false);
});
