import assert from "node:assert/strict";
import test from "node:test";
import {
  chatTitleFromMessages,
  enrichAdminChatItem,
  messageCount,
  rowToAdminChatUser,
  summarizeUserAgent,
  visitorFingerprint,
  type AdminChatUser,
} from "../src/admin-chats.ts";

test("visitorFingerprint is stable for the same IP + UA", () => {
  const a = visitorFingerprint("1.2.3.4", "Mozilla/5.0 Chrome/120");
  const b = visitorFingerprint("1.2.3.4", "Mozilla/5.0 Chrome/120");
  assert.equal(a, b);
  assert.match(a!, /^[0-9a-f]{8}$/);
});

test("visitorFingerprint changes when IP or UA changes", () => {
  const base = visitorFingerprint("1.2.3.4", "Mozilla/5.0 Chrome/120");
  assert.notEqual(base, visitorFingerprint("1.2.3.5", "Mozilla/5.0 Chrome/120"));
  assert.notEqual(base, visitorFingerprint("1.2.3.4", "Mozilla/5.0 Firefox/120"));
});

test("visitorFingerprint is null without IP and UA", () => {
  assert.equal(visitorFingerprint(null, null), null);
  assert.equal(visitorFingerprint("  ", "  "), null);
  assert.ok(visitorFingerprint("1.2.3.4", null));
  assert.ok(visitorFingerprint(null, "Mozilla/5.0"));
});

test("summarizeUserAgent extracts browser and OS", () => {
  assert.equal(
    summarizeUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
    "Chrome · macOS",
  );
  assert.equal(
    summarizeUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    ),
    "Firefox · Windows",
  );
  assert.equal(summarizeUserAgent(null), null);
  assert.equal(summarizeUserAgent(""), null);
});

test("chatTitleFromMessages uses the first user turn", () => {
  assert.equal(chatTitleFromMessages(null), null);
  assert.equal(
    chatTitleFromMessages([
      { role: "assistant", content: "hi" },
      { role: "user", content: "  What is SPY doing?  " },
    ]),
    "What is SPY doing?",
  );
  const long = "x".repeat(120);
  const title = chatTitleFromMessages([{ role: "user", content: long }], 96);
  assert.equal(title!.length, 96);
  assert.ok(title!.endsWith("…"));
});

test("messageCount ignores non-objects", () => {
  assert.equal(messageCount(null), 0);
  assert.equal(messageCount([{ role: "user", content: "a" }, "x", null]), 1);
});

test("enrichAdminChatItem attaches profile and clears fingerprint when signed in", () => {
  const user: AdminChatUser = {
    id: "u1",
    email: "someone@example.com",
    name: "Sam",
    image: null,
    handle: "sam",
    display_name: "Sam",
    public_name: "Sam",
    avatar_url: null,
    is_admin: false,
  };
  const users = new Map([["u1", user]]);
  const item = enrichAdminChatItem(
    {
      chat_id: "c1",
      mode: "funded",
      model: "x",
      user_id: "u1",
      ip: "1.2.3.4",
      user_agent: "Mozilla/5.0 Chrome/120",
      started_at: "2024-01-01T00:00:00.000Z",
      ended_at: "2024-01-01T00:01:00.000Z",
      source: "browser",
      fetched_at: "2024-01-01T00:01:01.000Z",
      messages: [{ role: "user", content: "hello world" }],
    },
    users,
  );
  assert.equal(item.user?.handle, "sam");
  assert.equal(item.visitor_fingerprint, null);
  assert.equal(item.title, "hello world");
  assert.equal(item.message_count, 1);
});

test("enrichAdminChatItem fingerprints anonymous visitors", () => {
  const item = enrichAdminChatItem(
    {
      chat_id: "c2",
      mode: "funded",
      model: null,
      user_id: null,
      ip: "9.9.9.9",
      user_agent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      started_at: "2024-01-01T00:00:00.000Z",
      ended_at: "2024-01-01T00:01:00.000Z",
      source: "browser",
      fetched_at: "2024-01-01T00:01:01.000Z",
      messages: [],
    },
    new Map(),
  );
  assert.equal(item.user, null);
  assert.match(item.visitor_fingerprint!, /^[0-9a-f]{8}$/);
  assert.equal(item.user_agent_summary, "Chrome · Linux");
});

test("rowToAdminChatUser maps profile fields", () => {
  const user = rowToAdminChatUser({
    id: "u1",
    email: "robert.lancer@gmail.com",
    name: "Rob",
    image: "https://example.com/g.jpg",
    handle: "thelobster",
    display_name: "The Lobster",
    avatar_key: "av1",
    profile_updated_at: 1_700_000_000_000,
  });
  assert.equal(user.is_admin, true);
  assert.equal(user.public_name, "The Lobster");
  assert.equal(user.avatar_url, "/api/avatars/u1?v=1700000000000");
});
