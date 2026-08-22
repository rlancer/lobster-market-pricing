import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCaptureToShareTurns,
  coalesceAssistantMessageRecords,
  coalesceAssistantShareTurns,
  promoteReasoningTakeaway,
  type ShareTurn,
} from "../src/share-turns.ts";

test("coalesceAssistantShareTurns merges consecutive recovery assistants", () => {
  const turns: ShareTurn[] = [
    { role: "user", content: "what do you think of going long uber?" },
    { role: "assistant", content: "" },
    {
      role: "assistant",
      content: "",
      reasoning: "The user is asking about going long Uber. Let me research.",
      sql: "SELECT 1",
    },
    {
      role: "assistant",
      content: "",
      reasoning: "The user is asking about going long Uber again after recovery.",
      sql: "SELECT earnings_date FROM options.earnings WHERE symbol = 'UBER'",
    },
  ];
  const out = coalesceAssistantShareTurns(turns);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].role, "assistant");
  assert.equal(out[1].sql, "SELECT earnings_date FROM options.earnings WHERE symbol = 'UBER'");
  assert.match(out[1].reasoning ?? "", /after recovery/);
  assert.equal(out[1].content, "(see reasoning)");
});

test("coalesceAssistantShareTurns prefers desk overview as content", () => {
  const turns: ShareTurn[] = [
    { role: "user", content: "Long UBER?" },
    { role: "assistant", content: "Let me query…", reasoning: "scratch" },
    {
      role: "assistant",
      content: "mid-turn",
      desk: {
        fundamental: "Uber's ride mix and margins look constructive on the latest print.",
        technical: "Price holds above the 21-day rising average with constructive volume.",
        options: "Oct puts still bid; defined-risk call spreads remain liquid near ATM.",
        overview: "Constructive long: fundamentals and tape agree; size via defined-risk calls.",
      },
    },
  ];
  const out = coalesceAssistantShareTurns(turns);
  assert.equal(out.length, 2);
  assert.equal(
    out[1].content,
    "Constructive long: fundamentals and tape agree; size via defined-risk calls.",
  );
  assert.ok(out[1].desk);
});

test("coalesceAssistantMessageRecords heals stored multi-bubble shares", () => {
  const out = coalesceAssistantMessageRecords([
    { role: "user", content: "long uber?" },
    { role: "assistant" },
    { role: "assistant", reasoning: "first attempt", sql: "SELECT a" },
    { role: "assistant", reasoning: "second attempt", sql: "SELECT b", result: { columns: ["b"], rows: [] } },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].sql, "SELECT b");
  assert.equal(out[1].reasoning, "second attempt");
  assert.deepEqual(out[1].result, { columns: ["b"], rows: [] });
});

test("promoteReasoningTakeaway lifts a conclusive reasoning paragraph into content", () => {
  const turned = promoteReasoningTakeaway({
    role: "assistant",
    content: "(see reasoning)",
    reasoning: [
      "Plan of tool calls:",
      "Batch 1: run_query for SPY/QQQ closes.",
      "",
      "Risk-off into the close: SPX and QQQ fade while VIX and TLT catch a bid. Stay light until the open confirms.",
    ].join("\n"),
    chart: { kind: "line", x: "date", y: "close" },
  });
  assert.match(turned.content, /Risk-off into the close/);
  assert.doesNotMatch(turned.content, /Plan of tool/i);
});

test("promoteReasoningTakeaway skips unfinished let-me narration", () => {
  const turned = promoteReasoningTakeaway({
    role: "assistant",
    content: "(see reasoning)",
    reasoning: "Let me query the options tape and then pull another window for the chart.",
  });
  assert.equal(turned.content, "(see reasoning)");
});

test("applyCaptureToShareTurns promotes reasoning after recovering chart/sql", () => {
  const out = applyCaptureToShareTurns(
    [
      { role: "user", content: "Hourly overview" },
      {
        role: "assistant",
        content: "(see reasoning)",
        reasoning: "Planning queries.\n\nSPY leads QQQ; IWM lags as the tape stays risk-off into the close.",
      },
    ],
    { sql: "SELECT 1", chart: { kind: "line", x: "date", y: "close" } },
    "Hourly overview",
  );
  assert.match(out[1]!.content, /SPY leads QQQ/);
  assert.ok(out[1]!.chart);
  assert.equal(out[1]!.sql, "SELECT 1");
});
