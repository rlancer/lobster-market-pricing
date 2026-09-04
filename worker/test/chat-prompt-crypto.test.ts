import assert from "node:assert/strict";
import test from "node:test";
import { deskAnalystBlock } from "../src/chat-desk.ts";
import { systemPrompt } from "../src/chat-prompt.ts";
import { CHAT_TOOL_DESCRIPTIONS } from "../src/chat-contract.ts";

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

test("systemPrompt requires get_portfolio when a portfolio is attached", () => {
  const body = systemPrompt("[schema]", {
    attachments: [{ kind: "portfolio", source: "schwab" }],
  });
  assert.match(body, /Attached context/);
  assert.match(body, /get_portfolio with source="schwab"/);
  assert.match(body, /Schwab portfolio/);
  assert.match(CHAT_TOOL_DESCRIPTIONS.get_portfolio, /source=schwab/);
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

test("systemPrompt asks for Markdown takeaways instead of a one-line blob", () => {
  const body = systemPrompt("[schema]");
  assert.match(body, /concise Markdown answer/);
  assert.match(body, /Never a single run-on line/);
  assert.match(body, /Write specialist takes, the overview, and the closing message as Markdown/);
  assert.doesNotMatch(body, /1-3 sentence takeaway/);
  assert.doesNotMatch(body, /1–3 sentence takeaway/);
  assert.doesNotMatch(body, /takeaway in plain prose/);
});

test("deskAnalystBlock tells options specialist spot crypto has no OCC root", () => {
  const body = deskAnalystBlock();
  assert.match(body, /BTC-USD/);
  assert.match(body, /no OCC root/i);
  assert.match(body, /IBIT/);
});

test("research_ticker tool description prefers BTC-USD for Bitcoin spot", () => {
  assert.match(CHAT_TOOL_DESCRIPTIONS.research_ticker, /BTC-USD/);
  assert.match(CHAT_TOOL_DESCRIPTIONS.research_ticker, /not IBIT/i);
});

test("systemPrompt requires identifying holdings before single-name concentration", () => {
  const body = systemPrompt("[schema]");
  assert.match(body, /lookup_symbols/);
  assert.match(body, /Single-name concentration/);
  assert.match(body, /sleeve\/beta size/);
  assert.match(body, /etf_holdings/);
  assert.match(CHAT_TOOL_DESCRIPTIONS.lookup_symbols, /top holdings/);
});

test("systemPrompt and get_schwab_quotes require owner-only live prints", () => {
  const body = systemPrompt("[schema]");
  assert.match(body, /get_schwab_quotes/);
  assert.match(body, /never pass a user id/);
  assert.match(CHAT_TOOL_DESCRIPTIONS.get_schwab_quotes, /THIS chat owner's connected Schwab token only/);
  assert.match(CHAT_TOOL_DESCRIPTIONS.get_schwab_quotes, /never a user id/);
});
