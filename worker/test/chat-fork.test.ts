import assert from "node:assert/strict";
import test from "node:test";
import {
  capShareAuthor,
  parseForkQuestion,
  parseShareId,
  stampForkAuthors,
  turnsFromShareMessages,
  uiMessagesFromSeedTurns,
  FORK_QUESTION_MAX,
} from "../src/chat-fork.ts";

test("parseShareId accepts base62 slugs", () => {
  assert.equal(parseShareId("TestShareId000000000000001"), "TestShareId000000000000001");
  assert.equal(parseShareId("  abc  "), "abc");
  assert.equal(parseShareId(""), null);
  assert.equal(parseShareId("bad id!"), null);
  assert.equal(parseShareId(null), null);
});

test("parseForkQuestion trims and caps length", () => {
  assert.equal(parseForkQuestion("  What about puts?  "), "What about puts?");
  assert.equal(parseForkQuestion(""), null);
  assert.equal(parseForkQuestion("   "), null);
  assert.equal(parseForkQuestion("x".repeat(FORK_QUESTION_MAX)), "x".repeat(FORK_QUESTION_MAX));
  assert.equal(parseForkQuestion("x".repeat(FORK_QUESTION_MAX + 1)), null);
});

test("turnsFromShareMessages keeps substance and drops empty shells", () => {
  const turns = turnsFromShareMessages([
    { role: "user", content: "  Buy SPY?  ", ts: 1 },
    { role: "assistant", content: "", reasoning: "thinking" },
    { role: "assistant", content: "" },
    { role: "assistant", content: "Thin liquidity." },
    { role: "system", content: "ignore" },
  ]);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].content, "Buy SPY?");
  assert.equal(turns[1].content, "(see reasoning)");
  assert.equal(turns[1].reasoning, "thinking");
  assert.equal(turns[2].content, "Thin liquidity.");
});

test("uiMessagesFromSeedTurns maps parts + metadata", () => {
  const messages = uiMessagesFromSeedTurns([
    { role: "user", content: "hello", ts: 10 },
    {
      role: "assistant",
      content: "world",
      reasoning: "why",
      sql: "SELECT 1",
      chart: { kind: "line", x: "a", y: "b" },
    },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].role, "assistant");
  assert.ok(messages[1].parts.some((p) => p.type === "reasoning"));
  const meta = messages[1].metadata as Record<string, unknown>;
  assert.equal(meta.sql, "SELECT 1");
  assert.ok(meta.chart);
});

test("stampForkAuthors leaves seeded user turns to parent and later to forker", () => {
  const messages: Record<string, unknown>[] = [
    { role: "user", content: "original" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "follow-up" },
  ];
  stampForkAuthors(
    messages,
    2,
    { handle: "alice", name: "Alice" },
    { handle: "bob", name: "Bob", avatar_url: "/api/avatars/bob" },
  );
  assert.deepEqual(messages[0].author, { handle: "alice", name: "Alice" });
  assert.equal(messages[1].author, undefined);
  assert.deepEqual(messages[2].author, {
    handle: "bob",
    name: "Bob",
    avatar_url: "/api/avatars/bob",
  });
});

test("stampForkAuthors does not overwrite an existing author", () => {
  const messages: Record<string, unknown>[] = [
    { role: "user", content: "q", author: { handle: "kept", name: "Kept" } },
  ];
  stampForkAuthors(messages, 0, { handle: "a", name: "A" }, { handle: "b", name: "B" });
  assert.deepEqual(messages[0].author, { handle: "kept", name: "Kept" });
});

test("capShareAuthor validates handle shape", () => {
  assert.deepEqual(
    capShareAuthor({ handle: "thelobster", name: "Rob", avatar_url: "/api/avatars/1" }),
    { handle: "thelobster", name: "Rob", avatar_url: "/api/avatars/1" },
  );
  assert.equal(capShareAuthor({ handle: "ab", name: "x" }), undefined);
  assert.equal(capShareAuthor({ handle: "Bad Handle", name: "x" }), undefined);
  assert.equal(capShareAuthor(null), undefined);
});
