import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NOTEBOOK_MODEL,
  parseNotebookProbeBody,
} from "../src/notebook-probe.ts";

test("parseNotebookProbeBody accepts text mode", () => {
  const parsed = parseNotebookProbeBody({
    mode: "text",
    question: "Which ticker won?",
    text_context: "AERO beat everyone.",
    model: "openai/gpt-4o-mini",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.mode, "text");
  assert.equal(parsed.model, "openai/gpt-4o-mini");
});

test("parseNotebookProbeBody accepts image data URLs", () => {
  const parsed = parseNotebookProbeBody({
    mode: "image",
    question: "Who won?",
    image_data_url: "data:image/png;base64,aaa",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.mode, "image");
});

test("parseNotebookProbeBody accepts multimodal text + image", () => {
  const parsed = parseNotebookProbeBody({
    mode: "multimodal",
    question: "Who won?",
    text_context: "| Color | Ticker |\n| teal | AERO |",
    image_data_url: "data:image/png;base64,aaa",
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.mode, "multimodal");
  assert.ok(parsed.text_context?.includes("AERO"));
  assert.ok(parsed.image_data_url?.startsWith("data:image/"));
});

test("parseNotebookProbeBody rejects missing fields", () => {
  const missingQ = parseNotebookProbeBody({ mode: "text", text_context: "x" });
  assert.equal(missingQ.ok, false);
  if (missingQ.ok) return;
  assert.equal(missingQ.status, 400);

  const missingText = parseNotebookProbeBody({ mode: "text", question: "q" });
  assert.equal(missingText.ok, false);

  const badImage = parseNotebookProbeBody({
    mode: "image",
    question: "q",
    image_data_url: "http://example.com/x.png",
  });
  assert.equal(badImage.ok, false);

  const multimodalMissingText = parseNotebookProbeBody({
    mode: "multimodal",
    question: "q",
    image_data_url: "data:image/png;base64,aaa",
  });
  assert.equal(multimodalMissingText.ok, false);
});

test("DEFAULT_NOTEBOOK_MODEL is a multimodal OpenRouter slug", () => {
  assert.match(DEFAULT_NOTEBOOK_MODEL, /\//);
});
