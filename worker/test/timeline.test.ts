import assert from "node:assert/strict";
import test from "node:test";
import { groupTickersByChat } from "../src/chat-tickers.ts";
import {
  excerptFromMessages,
  flagsFromMessages,
  parseTimelineQuery,
  previewMessagesFromShare,
  resolveUnpublishAccess,
} from "../src/timeline.ts";

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

test("excerptFromMessages keeps paragraph breaks and the full first message", () => {
  const body = "Technology leads open interest.\n\nHealthcare is second.";
  assert.equal(
    excerptFromMessages([{ role: "assistant", content: `  ${body}  ` }], null),
    body,
  );
  const long = "word ".repeat(200).trim();
  const excerpt = excerptFromMessages([{ role: "assistant", content: `a\n\n${long}` }], null);
  assert.equal(excerpt.startsWith("a\n\n"), true);
  assert.equal(excerpt.includes(long), true);
  assert.equal(excerpt.endsWith("…"), false);
});

test("previewMessagesFromShare returns the full slimmed conversation with sql and reasoning", () => {
  const preview = previewMessagesFromShare([
    { role: "user", content: "Best calls?" },
    {
      role: "assistant",
      content: "FISV leads.",
      reasoning: "Scan ATM calls by OI.",
      sql: "SELECT 1",
      result: { columns: ["a"], rows: [{ a: 1 }], row_count: 1 },
      chart: { kind: "bar", x: "a", y: "a" },
    },
    { role: "user", content: "More?" },
    { role: "assistant", content: "Later turn." },
  ]);
  assert.equal(preview.length, 4);
  assert.deepEqual(preview[0], { role: "user", content: "Best calls?" });
  assert.equal(preview[1]?.role, "assistant");
  assert.equal(preview[1]?.content, "FISV leads.");
  assert.equal(preview[1]?.reasoning, "Scan ATM calls by OI.");
  assert.equal(preview[1]?.sql, "SELECT 1");
  assert.deepEqual(preview[1]?.chart, { kind: "bar", x: "a", y: "a" });
  assert.equal("result" in (preview[1] ?? {}), false);
  assert.deepEqual(preview[2], { role: "user", content: "More?" });
  assert.deepEqual(preview[3], { role: "assistant", content: "Later turn." });
});

test("previewMessagesFromShare falls back to a lone user turn or title", () => {
  assert.deepEqual(
    previewMessagesFromShare([{ role: "user", content: "Hello" }]),
    [{ role: "user", content: "Hello" }],
  );
  assert.deepEqual(
    previewMessagesFromShare([], "Saved title"),
    [{ role: "assistant", content: "Saved title" }],
  );
  assert.deepEqual(previewMessagesFromShare([]), []);
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

test("groupTickersByChat keeps first-seen order and uppercases symbols", () => {
  const grouped = groupTickersByChat([
    { chat_id: "c1", ticker: "nvda" },
    { chat_id: "c1", ticker: "AAPL" },
    { chat_id: "c1", ticker: "NVDA" },
    { chat_id: "c2", ticker: " MSFT " },
    { chat_id: "", ticker: "SKIP" },
    { chat_id: "c2", ticker: "" },
  ]);
  assert.deepEqual(grouped.get("c1"), ["NVDA", "AAPL"]);
  assert.deepEqual(grouped.get("c2"), ["MSFT"]);
  assert.equal(grouped.has(""), false);
});

test("resolveUnpublishAccess allows owners and admins; bots are admin-only", () => {
  assert.deepEqual(
    resolveUnpublishAccess({ admin: false, userId: "u1", postUserId: "u1", hasBotHandle: false }),
    { unpublishHuman: true, unpublishBot: false, forbidden: false },
  );
  assert.deepEqual(
    resolveUnpublishAccess({ admin: false, userId: "u1", postUserId: "u2", hasBotHandle: false }),
    { unpublishHuman: false, unpublishBot: false, forbidden: true },
  );
  assert.deepEqual(
    resolveUnpublishAccess({ admin: true, userId: "admin", postUserId: "u2", hasBotHandle: false }),
    { unpublishHuman: true, unpublishBot: false, forbidden: false },
  );
  assert.deepEqual(
    resolveUnpublishAccess({ admin: false, userId: "u1", postUserId: null, hasBotHandle: true }),
    { unpublishHuman: false, unpublishBot: false, forbidden: true },
  );
  assert.deepEqual(
    resolveUnpublishAccess({ admin: true, userId: "admin", postUserId: null, hasBotHandle: true }),
    { unpublishHuman: false, unpublishBot: true, forbidden: false },
  );
  assert.deepEqual(
    resolveUnpublishAccess({ admin: true, userId: "admin", postUserId: "u2", hasBotHandle: true }),
    { unpublishHuman: true, unpublishBot: true, forbidden: false },
  );
  assert.deepEqual(
    resolveUnpublishAccess({ admin: false, userId: "u1", postUserId: null, hasBotHandle: false }),
    { unpublishHuman: false, unpublishBot: false, forbidden: false },
  );
});
