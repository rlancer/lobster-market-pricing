import assert from "node:assert/strict";
import test from "node:test";
import { describeChatCapabilities } from "../src/chat-capabilities.ts";
import { CHAT_TOOL_DESCRIPTIONS, CHAT_TOOL_INPUT_SCHEMAS } from "../src/chat-contract.ts";
import { SCHEMA_PLACEHOLDER } from "../src/chat-prompt.ts";
import type { LakeTable } from "../src/chat-sql.ts";

test("describeChatCapabilities lists every tool with JSON schema", () => {
  const caps = describeChatCapabilities();
  const names = caps.tools.map((tool) => tool.name);
  assert.deepEqual(names, Object.keys(CHAT_TOOL_INPUT_SCHEMAS));
  for (const tool of caps.tools) {
    assert.equal(tool.description, CHAT_TOOL_DESCRIPTIONS[tool.name]);
    assert.equal(tool.input_schema.type, "object");
    assert.ok(tool.label.length > 0);
  }
  assert.equal(caps.meta.schema_mode, "placeholder");
  assert.equal(caps.meta.table_count, 0);
});

test("describeChatCapabilities exposes the known system prompts", () => {
  const caps = describeChatCapabilities();
  const ids = caps.prompts.map((prompt) => prompt.id);
  assert.deepEqual(ids, [
    "chat",
    "desk-analysts",
    "suggest-trades",
    "bot-addon",
    "reply-style",
    "chat-attachments",
    "scope-classifier",
    "chat-meta",
    "bot-prompt-invent",
    "research-commentary",
    "el5-post",
  ]);
  const chatPrompt = caps.prompts.find((prompt) => prompt.id === "chat");
  assert.ok(chatPrompt);
  assert.match(chatPrompt.body, /multi-analyst/);
  assert.match(chatPrompt.body, /publish_desk/);
  assert.match(chatPrompt.body, /suggest_trades/);
  assert.match(chatPrompt.body, /BTC-USD/);
  assert.match(chatPrompt.body, /spot crypto/i);
  assert.doesNotMatch(chatPrompt.body, /ONLY answer US equities, ETF, options/);
  assert.ok(chatPrompt.body.includes(SCHEMA_PLACEHOLDER));
  const desk = caps.prompts.find((prompt) => prompt.id === "desk-analysts");
  assert.ok(desk);
  assert.match(desk.body, /Fundamental analyst/);
  assert.match(desk.body, /Risk analyst/);
  assert.match(desk.body, /Macro analyst/);
  assert.match(desk.body, /BTC-USD/);
  const trades = caps.prompts.find((prompt) => prompt.id === "suggest-trades");
  assert.ok(trades);
  assert.match(trades.body, /suggest_trades/);
  const scope = caps.prompts.find((prompt) => prompt.id === "scope-classifier");
  assert.ok(scope);
  assert.match(scope.body, /BTC-USD/);
  assert.match(scope.body, /spot crypto/i);
  assert.ok(caps.tools.some((tool) => tool.name === "publish_desk"));
  assert.ok(caps.tools.some((tool) => tool.name === "suggest_trades"));
  const research = caps.tools.find((tool) => tool.name === "research_ticker");
  assert.ok(research);
  assert.match(research.description, /BTC-USD/);
});

test("describeChatCapabilities can embed a live lake schema without samples", () => {
  const tables: LakeTable[] = [
    {
      name: "option_contracts",
      columns: [
        { name: "symbol", type: "VARCHAR" },
        { name: "strike", type: "DOUBLE" },
      ],
      sample: [{ symbol: "SPY", strike: 500 }],
      row_count: 12,
    },
  ];
  const caps = describeChatCapabilities({ tables, includeSamples: false });
  assert.equal(caps.meta.schema_mode, "live");
  assert.equal(caps.meta.table_count, 1);
  assert.equal(caps.meta.schema_include_samples, false);
  const chatPrompt = caps.prompts.find((prompt) => prompt.id === "chat");
  assert.ok(chatPrompt);
  assert.match(chatPrompt.body, /TABLE options\.option_contracts/);
  assert.match(chatPrompt.body, /symbol VARCHAR/);
  assert.doesNotMatch(chatPrompt.body, /sample rows/);
  // Schema samples must stay out of the prompt; SPY may still appear in desk routing copy.
  assert.doesNotMatch(chatPrompt.body, /"symbol":\s*"SPY"/);
  assert.doesNotMatch(chatPrompt.body, /strike.: 500/);
});
