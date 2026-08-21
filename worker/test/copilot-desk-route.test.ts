import assert from "node:assert/strict";
import test from "node:test";
import {
  extractMentionedSymbols,
  questionWantsMacro,
  questionWantsRisk,
  selectDeskSpecialists,
} from "../src/copilot-desk-route.ts";

test("extractMentionedSymbols finds $tickers and bare macro ETFs", () => {
  assert.ok(extractMentionedSymbols("look at $GME options").includes("GME"));
  assert.ok(extractMentionedSymbols("compare SPY and TLT").includes("SPY"));
  assert.ok(extractMentionedSymbols("compare SPY and TLT").includes("TLT"));
  assert.ok(extractMentionedSymbols("BTC-USD vs ETH-USD").includes("BTC-USD"));
});

test("questionWantsMacro detects underlyings and keywords", () => {
  assert.equal(questionWantsMacro("GME options chain liquidity"), false);
  assert.equal(questionWantsMacro("SPY into CPI week"), true);
  assert.equal(questionWantsMacro("what did the Fed signal?"), true);
});

test("questionWantsRisk detects hedge / sizing language", () => {
  assert.equal(questionWantsRisk("GME options chain"), false);
  assert.equal(questionWantsRisk("position sizing and stop-loss on NVDA"), true);
  assert.equal(questionWantsRisk("trade idea on AAPL with defined risk"), true);
});

test("selectDeskSpecialists keeps single-name desks free of macro", () => {
  assert.deepEqual(
    selectDeskSpecialists("analyze NVDA earnings and the options chain"),
    ["fundamental", "technical", "options"],
  );
});

test("selectDeskSpecialists can route from a short reply note", () => {
  const specialists = selectDeskSpecialists("what's the take?", "I care about rates and the Fed.");
  assert.ok(specialists.includes("macro"));
});
