import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSaveExperimentRunBody,
} from "../src/experiment-runs.ts";

const minimalResults = {
  design_id: "text-vs-image-v2",
  manifest: {
    runner_version: 2,
    source_revision: "abc123",
    system_prompt_sha256: "a".repeat(64),
    questions_sha256: "b".repeat(64),
    representation_sha256: {
      tool_summary: "c".repeat(64),
      overlay_normalized: "d".repeat(64),
    },
    execution_order: [
      "overlay_normalized::q1",
      "tool_summary::q1",
    ],
    max_probe_attempts: 3,
  },
  questions: [{ id: "q1", prompt: "Who won?", expected: "AERO" }],
  text_reps: [{
    id: "tool_summary",
    label: "Tool summary",
    description: "baseline",
    body: "AERO won",
    approx_tokens: 10,
  }],
  cells: [{
    rep_id: "tool_summary",
    question_id: "q1",
    status: "done" as const,
    answer: "AERO",
    correct: true,
    latency_ms: 12,
  }, {
    rep_id: "overlay_normalized",
    question_id: "q1",
    status: "done" as const,
    answer: "AERO",
    correct: true,
    latency_ms: 15,
  }],
  rep_order: ["tool_summary", "overlay_normalized"],
};

const minimalImage = {
  id: "overlay_normalized",
  label: "Overlay",
  description: "lines",
  width: 100,
  height: 80,
  data_url: "data:image/png;base64,aaa",
};

test("parseSaveExperimentRunBody accepts a complete run", () => {
  const parsed = parseSaveExperimentRunBody({
    experiment_slug: "text-vs-image",
    model: "openai/gpt-4o-mini",
    seed: 42,
    results: minimalResults,
    images: [minimalImage],
  }, "text-vs-image");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.input.seed, 42);
  assert.equal(parsed.input.images.length, 1);
  assert.equal(parsed.input.results.cells.length, 2);
  assert.equal(parsed.input.results.design_id, "text-vs-image-v2");
});

test("parseSaveExperimentRunBody rejects slug mismatch", () => {
  const parsed = parseSaveExperimentRunBody({
    experiment_slug: "other",
    model: "m",
    seed: 1,
    results: minimalResults,
    images: [minimalImage],
  }, "text-vs-image");
  assert.equal(parsed.ok, false);
});

test("parseSaveExperimentRunBody requires images fed to the model", () => {
  const parsed = parseSaveExperimentRunBody({
    model: "m",
    seed: 1,
    results: minimalResults,
    images: [],
  }, "text-vs-image");
  assert.equal(parsed.ok, false);
});

test("parseSaveExperimentRunBody rejects non-data-url images", () => {
  const parsed = parseSaveExperimentRunBody({
    model: "m",
    seed: 1,
    results: minimalResults,
    images: [{ ...minimalImage, data_url: "https://cdn.example/x.png" }],
  }, "text-vs-image");
  assert.equal(parsed.ok, false);
});

test("parseSaveExperimentRunBody rejects incomplete matrices", () => {
  const parsed = parseSaveExperimentRunBody({
    model: "m",
    seed: 1,
    results: {
      ...minimalResults,
      cells: minimalResults.cells.slice(0, 1),
    },
    images: [minimalImage],
  }, "text-vs-image");
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /exactly 2 cells/i);
});

test("parseSaveExperimentRunBody rejects unversioned runs", () => {
  const { design_id: _designId, ...unversioned } = minimalResults;
  const parsed = parseSaveExperimentRunBody({
    model: "m",
    seed: 1,
    results: unversioned,
    images: [minimalImage],
  }, "text-vs-image");
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /design_id/i);
});

test("summarizeExperimentResultsJson exposes per-rep accuracy", async () => {
  const { summarizeExperimentResultsJson } = await import("../src/experiment-runs.ts");
  const summary = summarizeExperimentResultsJson(JSON.stringify({
    design_id: "text-vs-image-v2",
    questions: [{ id: "q1", prompt: "Who?", expected: "AERO" }],
    text_reps: [],
    cells: [
      { rep_id: "tool_summary", question_id: "q1", status: "done", correct: true },
      { rep_id: "tool_summary", question_id: "q2", status: "done", correct: false },
      { rep_id: "ranked_bars", question_id: "q1", status: "done", correct: true },
      { rep_id: "ranked_bars", question_id: "q2", status: "error" },
    ],
    rep_order: ["tool_summary", "ranked_bars"],
  }));
  assert.equal(summary.cells_done, 3);
  assert.equal(summary.cells_correct, 2);
  assert.equal(summary.design_id, "text-vs-image-v2");
  assert.equal(summary.matrix_complete, false);
  assert.deepEqual(summary.rep_order, ["tool_summary", "ranked_bars"]);
  assert.deepEqual(summary.rep_accuracy, [
    { rep_id: "tool_summary", correct: 1, done: 2 },
    { rep_id: "ranked_bars", correct: 1, done: 1 },
  ]);
});
