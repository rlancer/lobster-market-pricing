import assert from "node:assert/strict";
import test from "node:test";
import {
  deskAnalystBlock,
  deskViewpointsFromBrief,
  formatDeskToolSummary,
  normalizeDeskBrief,
} from "../src/copilot-desk.ts";

test("normalizeDeskBrief requires all four fields", () => {
  assert.equal(normalizeDeskBrief({
    fundamental: "",
    technical: "trend up",
    options: "call debit",
    overview: "net bullish",
  }), null);
  const desk = normalizeDeskBrief({
    fundamental: "EPS beat, guidance raised",
    technical: "Holding above 21d MA",
    options: "Near-ATM calls quote two-sided",
    overview: "Lean bullish with defined risk",
  });
  assert.ok(desk);
  assert.equal(desk.fundamental, "EPS beat, guidance raised");
  assert.equal(deskViewpointsFromBrief(desk).length, 3);
  assert.match(formatDeskToolSummary(desk), /Desk viewpoints published/);
});

test("deskAnalystBlock names all three specialists and publish_desk", () => {
  const block = deskAnalystBlock();
  assert.match(block, /Fundamental analyst/);
  assert.match(block, /Technical analyst/);
  assert.match(block, /Options trader/);
  assert.match(block, /publish_desk/);
  assert.match(block, /Never overweight technical analysis/);
});
