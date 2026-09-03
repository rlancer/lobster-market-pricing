import assert from "node:assert/strict";
import test from "node:test";
import { deskAnalystBlock } from "../src/copilot-desk.ts";
import { systemPrompt } from "../src/copilot-prompt.ts";
import { COPILOT_TOOL_DESCRIPTIONS } from "../src/copilot-contract.ts";

test("systemPrompt teaches the desk that spot Bitcoin is BTC-USD in the lake", () => {
  const body = systemPrompt("[schema]");
  assert.match(body, /BTC-USD/);
  assert.match(body, /spot crypto/i);
  assert.match(body, /do NOT substitute IBIT/i);
  assert.match(body, /BTC=F/);
  assert.doesNotMatch(body, /ONLY answer US equities, ETF, options/);
});

test("systemPrompt defaults interactive chat to the desk reply voice", () => {
  const body = systemPrompt("[schema]");
  assert.match(body, /Audience: working trader/);
  assert.match(body, /never overrides SQL/);
});

test("systemPrompt applies a fund reply voice and skips it for bots", () => {
  const fund = systemPrompt("[schema]", { reply: { style: "fund", note: "I run a vol book." } });
  assert.match(fund, /hedge-fund/);
  assert.match(fund, /I run a vol book/);
  const bot = systemPrompt("[schema]", {
    bot: {
      handle: "macrolobster",
      display_name: "Macro Lobster",
      persona: "Rates, the curve, and the cycle",
      system_prompt_extra: "Lead with options.yields.",
    },
    reply: { style: "learner", note: "should not appear" },
  });
  assert.match(bot, /@macrolobster/);
  assert.doesNotMatch(bot, /should not appear/);
  assert.doesNotMatch(bot, /Audience: new to trading/);
});

test("systemPrompt requires publish_desk on bot timeline posts", () => {
  const body = systemPrompt("[schema]", {
    handle: "macrolobster",
    display_name: "Macro Lobster",
    persona: "Rates, the curve, and the cycle",
    system_prompt_extra: "Lead with options.yields.",
  });
  assert.match(body, /MUST still call publish_desk/);
  assert.match(body, /specialist personas/);
  assert.doesNotMatch(body, /optional for timeline posts/);
  assert.doesNotMatch(body, /prefer a single sharp voice/);
});

test("deskAnalystBlock tells options specialist spot crypto has no OCC root", () => {
  const body = deskAnalystBlock();
  assert.match(body, /BTC-USD/);
  assert.match(body, /no OCC root/i);
  assert.match(body, /IBIT/);
});

test("research_ticker tool description prefers BTC-USD for Bitcoin spot", () => {
  assert.match(COPILOT_TOOL_DESCRIPTIONS.research_ticker, /BTC-USD/);
  assert.match(COPILOT_TOOL_DESCRIPTIONS.research_ticker, /not IBIT/i);
});

test("systemPrompt and get_schwab_quotes require owner-only live prints", () => {
  const body = systemPrompt("[schema]");
  assert.match(body, /get_schwab_quotes/);
  assert.match(body, /never pass a user id/);
  assert.match(COPILOT_TOOL_DESCRIPTIONS.get_schwab_quotes, /THIS chat owner's connected Schwab token only/);
  assert.match(COPILOT_TOOL_DESCRIPTIONS.get_schwab_quotes, /never a user id/);
});
