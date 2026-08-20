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
    fundamental: "EPS beat, guidance raised with durable services mix still expanding.",
    technical: "Holding above the 21d MA after a tight consolidation range.",
    options: "Near-ATM calls quote two-sided with usable open interest.",
    overview: "Lean bullish with defined risk while liquidity holds up.",
  });
  assert.ok(desk);
  assert.match(desk.fundamental, /EPS beat/);
  assert.equal(deskViewpointsFromBrief(desk).length, 3);
  assert.match(formatDeskToolSummary(desk), /Desk viewpoints published/);
});

test("normalizeDeskBrief rejects placeholder stubs", () => {
  // Regression: GME share ynQcuupDNBG04fcaYleY01hi — forced publish_desk emitted
  // literal "placeholder" and the loop sealed before a real desk could land.
  assert.equal(normalizeDeskBrief({
    fundamental: "placeholder",
    technical: "placeholder",
    options: "placeholder",
    overview: "placeholder",
  }), null);
  assert.equal(normalizeDeskBrief({
    fundamental: "TBD",
    technical: "Holding above the 21d MA after a tight consolidation range.",
    options: "Near-ATM calls quote two-sided with usable open interest.",
    overview: "Lean bullish with defined risk while liquidity holds up.",
  }), null);
});

test("deskAnalystBlock names all three specialists and publish_desk", () => {
  const block = deskAnalystBlock();
  assert.match(block, /Fundamental analyst/);
  assert.match(block, /Technical analyst/);
  assert.match(block, /Options trader/);
  assert.match(block, /publish_desk/);
  assert.match(block, /suggest_trades/);
  assert.match(block, /placeholder/);
  assert.match(block, /Never overweight technical analysis/);
});
