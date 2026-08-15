import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_EVENT_ARGS_MAX,
  normalizeToolEvent,
  parseToolEventListQuery,
  serializeToolArgs,
} from "../src/copilot-tool-events.ts";

test("serializeToolArgs keeps small payloads intact", () => {
  assert.equal(serializeToolArgs({ sql: "SELECT 1" }), '{"sql":"SELECT 1"}');
  assert.equal(serializeToolArgs(null), "null");
});

test("serializeToolArgs truncates oversized args", () => {
  const big = { sql: "x".repeat(TOOL_EVENT_ARGS_MAX + 100) };
  const raw = serializeToolArgs(big);
  assert.ok(raw.length <= TOOL_EVENT_ARGS_MAX + 80);
  const parsed = JSON.parse(raw) as { _truncated?: boolean; preview?: string };
  assert.equal(parsed._truncated, true);
  assert.ok(typeof parsed.preview === "string");
});

test("normalizeToolEvent caps fields and requires ids", () => {
  const row = normalizeToolEvent({
    event_id: " ev-1 ",
    chat_id: "chat-1",
    turn_id: "turn-1",
    tool_name: "run_query",
    ok: false,
    args: { sql: "SELECT 1" },
    error: " boom ",
    summary: "Query failed",
    sql: "SELECT 1",
    duration_ms: 12.7,
    model: "test/model",
    created_at: 1_700_000_000_000,
  });
  assert.equal(row.event_id, "ev-1");
  assert.equal(row.ok, 0);
  assert.equal(row.error, "boom");
  assert.equal(row.sql_text, "SELECT 1");
  assert.equal(row.duration_ms, 13);
  assert.equal(row.created_at, 1_700_000_000_000);
  assert.throws(() => normalizeToolEvent({
    event_id: "",
    chat_id: "c",
    turn_id: "t",
    tool_name: "run_query",
    ok: true,
    args: {},
  }));
});

test("parseToolEventListQuery defaults ok to failures and accepts ok=all", () => {
  assert.deepEqual(parseToolEventListQuery(new URLSearchParams()), {
    chat_id: null,
    share_id: null,
    tool: null,
    ok: false,
    limit: 100,
    before: null,
  });
  assert.deepEqual(parseToolEventListQuery(new URLSearchParams("ok=all&limit=10")), {
    chat_id: null,
    share_id: null,
    tool: null,
    ok: null,
    limit: 10,
    before: null,
  });
  assert.deepEqual(
    parseToolEventListQuery(new URLSearchParams("ok=true&tool=run_query&chat_id=abc&share_id=share1")),
    { chat_id: "abc", share_id: "share1", tool: "run_query", ok: true, limit: 100, before: null },
  );
  assert.equal(parseToolEventListQuery(new URLSearchParams("tool=nope")).error, "unknown tool 'nope'");
  assert.equal(parseToolEventListQuery(new URLSearchParams("ok=maybe")).error, "ok must be true, false, or all");
  assert.equal(parseToolEventListQuery(new URLSearchParams("limit=0")).error, "limit must be a positive integer");
  assert.equal(parseToolEventListQuery(new URLSearchParams("before=nope")).error, "before must be an ISO timestamp");
});
