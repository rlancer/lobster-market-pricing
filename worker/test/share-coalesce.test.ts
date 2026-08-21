import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coalesceAssistantMessageRecords,
  coalesceAssistantShareTurns,
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
