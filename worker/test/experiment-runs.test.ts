import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSaveExperimentRunBody,
} from "../src/experiment-runs.ts";

const minimalResults = {
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
  assert.equal(parsed.input.results.cells.length, 1);
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
