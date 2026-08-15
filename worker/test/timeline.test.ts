import assert from "node:assert/strict";
import test from "node:test";
import { excerptFromMessages, flagsFromMessages, parseTimelineQuery } from "../src/timeline.ts";

test("excerptFromMessages prefers the first assistant answer", () => {
  assert.equal(
    excerptFromMessages(
      [
        { role: "user", content: "Which sector leads OI?" },
        { role: "assistant", content: "Technology leads open interest." },
      ],
      "Which sector leads OI?",
    ),
    "Technology leads open interest.",
  );
});

test("excerptFromMessages falls back to the user turn, then the title", () => {
  assert.equal(
    excerptFromMessages([{ role: "user", content: "  Chart NVDA  " }], null),
    "Chart NVDA",
  );
  assert.equal(excerptFromMessages([], "Saved title"), "Saved title");
  assert.equal(excerptFromMessages(null, null), "");
});

test("excerptFromMessages collapses whitespace and caps length", () => {
  const long = "word ".repeat(200).trim();
  const excerpt = excerptFromMessages([{ role: "assistant", content: `a\n\n${long}` }], null);
  assert.ok(excerpt.length <= 280);
  assert.equal(excerpt.endsWith("…"), true);
  assert.equal(excerpt.includes("\n"), false);
});

test("flagsFromMessages detects sql and chart snapshots", () => {
  assert.deepEqual(flagsFromMessages([]), { has_sql: false, has_chart: false });
  assert.deepEqual(
    flagsFromMessages([{ role: "assistant", sql: "SELECT 1", chart: { kind: "bar", x: "a", y: "b" } }]),
    { has_sql: true, has_chart: true },
  );
  assert.deepEqual(
    flagsFromMessages([{ role: "assistant", sql: "   ", chart: "nope" }]),
    { has_sql: false, has_chart: false },
  );
});

test("parseTimelineQuery defaults, caps limit, and validates handle/before", () => {
  assert.deepEqual(parseTimelineQuery(new URLSearchParams()), {
    ok: true,
    limit: 30,
    before: null,
    handle: null,
  });
  const capped = parseTimelineQuery(new URLSearchParams("limit=999&before=100&handle=Rob"));
  assert.deepEqual(capped, { ok: true, limit: 50, before: 100, handle: "rob" });
  const badLimit = parseTimelineQuery(new URLSearchParams("limit=0"));
  assert.equal(badLimit.ok, false);
  const badHandle = parseTimelineQuery(new URLSearchParams("handle=no_pe"));
  assert.equal(badHandle.ok, false);
  const badBefore = parseTimelineQuery(new URLSearchParams("before=nope"));
  assert.equal(badBefore.ok, false);
});
