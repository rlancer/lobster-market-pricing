import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  parseSaveExperimentRunBody,
} from "../src/experiment-runs.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const systemPrompt = "Use only the supplied context.";
const questions = [{
  id: "q1",
  prompt: "Who won?",
  expected: "AERO",
  kind: "ticker",
}];
const repOrder = ["tool_summary", "overlay_normalized"];
const representationHashes = {
  tool_summary: sha256("AERO won"),
  overlay_normalized: sha256("data:image/png;base64,aaa"),
};
const designFingerprint = sha256([
  "text-vs-image-v2",
  "2",
  sha256(systemPrompt),
  sha256(JSON.stringify(questions)),
  ...repOrder.map((id) => `${id}:${representationHashes[id as keyof typeof representationHashes]}`),
].join("\n"));

const minimalResults = {
  design_id: "text-vs-image-v2",
  manifest: {
    runner_version: 2,
    source_revision: "abc123",
    system_prompt: systemPrompt,
    system_prompt_sha256: sha256(systemPrompt),
    questions_sha256: sha256(JSON.stringify(questions)),
    representation_sha256: representationHashes,
    design_fingerprint_sha256: designFingerprint,
    execution_order: [
      "overlay_normalized::q1",
      "tool_summary::q1",
    ],
    max_probe_attempts: 3,
  },
  questions,
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
  rep_order: repOrder,
};

const minimalImage = {
  id: "overlay_normalized",
  label: "Overlay",
  description: "lines",
  width: 100,
  height: 80,
  data_url: "data:image/png;base64,aaa",
};

test("parseSaveExperimentRunBody accepts a complete run", async () => {
  const parsed = await parseSaveExperimentRunBody({
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

test("parseSaveExperimentRunBody rejects slug mismatch", async () => {
  const parsed = await parseSaveExperimentRunBody({
    experiment_slug: "other",
    model: "m",
    seed: 1,
    results: minimalResults,
    images: [minimalImage],
  }, "text-vs-image");
  assert.equal(parsed.ok, false);
});

test("parseSaveExperimentRunBody requires images fed to the model", async () => {
  const parsed = await parseSaveExperimentRunBody({
    model: "m",
    seed: 1,
    results: minimalResults,
    images: [],
  }, "text-vs-image");
  assert.equal(parsed.ok, false);
});

test("parseSaveExperimentRunBody rejects non-data-url images", async () => {
  const parsed = await parseSaveExperimentRunBody({
    model: "m",
    seed: 1,
    results: minimalResults,
    images: [{ ...minimalImage, data_url: "https://cdn.example/x.png" }],
  }, "text-vs-image");
  assert.equal(parsed.ok, false);
});

test("parseSaveExperimentRunBody rejects incomplete matrices", async () => {
  const parsed = await parseSaveExperimentRunBody({
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

test("parseSaveExperimentRunBody rejects unversioned runs", async () => {
  const { design_id: _designId, ...unversioned } = minimalResults;
  const parsed = await parseSaveExperimentRunBody({
    model: "m",
    seed: 1,
    results: unversioned,
    images: [minimalImage],
  }, "text-vs-image");
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /design_id/i);
});

test("parseSaveExperimentRunBody rejects false manifest attestations", async () => {
  const parsed = await parseSaveExperimentRunBody({
    model: "m",
    seed: 1,
    results: {
      ...minimalResults,
      manifest: {
        ...minimalResults.manifest,
        questions_sha256: "f".repeat(64),
      },
    },
    images: [minimalImage],
  }, "text-vs-image");
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /questions hash does not match/i);
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

test("parseSaveExperimentRunBody stores context footprints", async () => {
  const parsed = await parseSaveExperimentRunBody({
    experiment_slug: "text-vs-image",
    model: "openai/gpt-4o-mini",
    seed: 42,
    results: {
      ...minimalResults,
      rep_footprints: [{
        rep_id: "tool_summary",
        mode: "text",
        text_tokens: 1200,
        image_tokens: 0,
        total_tokens: 1200,
        estimator: "openai-gpt4o-high-detail-tiles+chars/4",
      }, {
        rep_id: "overlay_normalized",
        mode: "image",
        text_tokens: 0,
        image_tokens: 765,
        total_tokens: 765,
        image_width: 1024,
        image_height: 1024,
        image_tiles: 4,
      }],
    },
    images: [minimalImage],
  }, "text-vs-image");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.input.results.rep_footprints?.length, 2);
  assert.equal(parsed.input.results.rep_footprints?.[0]?.total_tokens, 1200);
});
