import assert from "node:assert/strict";
import test from "node:test";
import { cookieDomainFor, isTrustedOrigin, trustedOrigins } from "../src/auth.ts";
import { copilotAgentChatId, compareUserChats, historyTitle, parseChatId, sortUserChats, titleFromMessages } from "../src/user-chats.ts";

test("parseChatId accepts UUIDs and rejects junk", () => {
  const id = "3b1d0a2e-7c4f-4a11-9f2d-8e6c1b0a9d77";
  assert.equal(parseChatId(id), id);
  assert.equal(parseChatId(` ${id} `), id);
  assert.equal(parseChatId("not-a-uuid"), null);
  assert.equal(parseChatId(""), null);
  assert.equal(parseChatId(null), null);
});

test("copilotAgentChatId reads the Agent instance name", () => {
  const id = "3b1d0a2e-7c4f-4a11-9f2d-8e6c1b0a9d77";
  assert.equal(copilotAgentChatId(`/agents/copilot-agent/${id}`), id);
  assert.equal(copilotAgentChatId(`/agents/copilot-agent/${id}/get-messages`), id);
  assert.equal(copilotAgentChatId("/api/chats"), null);
  assert.equal(copilotAgentChatId("/agents/copilot-agent/nope"), null);
});

test("historyTitle rejects blank titles so Untitled shells stay out of the list", () => {
  assert.equal(historyTitle(null), null);
  assert.equal(historyTitle(undefined), null);
  assert.equal(historyTitle(""), null);
  assert.equal(historyTitle("   "), null);
  assert.equal(historyTitle("Chart NVDA"), "Chart NVDA");
  assert.equal(historyTitle("  Chart NVDA  "), "Chart NVDA");
});

test("titleFromMessages uses the first user turn, never client user_id", () => {
  assert.equal(titleFromMessages([{ role: "user", content: "  Chart NVDA smile  " }]), "Chart NVDA smile");
  assert.equal(
    titleFromMessages([{ role: "assistant", content: "hi" }, { role: "user", content: "second" }]),
    "second",
  );
  assert.equal(titleFromMessages([], "Saved title"), "Saved title");
  assert.equal(titleFromMessages([], "  "), null);
  const long = "x".repeat(200);
  assert.equal(titleFromMessages([{ role: "user", content: long }])?.length, 120);
});

test("cookie domain is parent-host on lobster.mp and host-only elsewhere", () => {
  assert.equal(cookieDomainFor("https://api.lobster.mp/api/auth/callback/google"), "lobster.mp");
  assert.equal(cookieDomainFor("https://api-dev.lobster.mp/api/auth/get-session"), "lobster.mp");
  assert.equal(cookieDomainFor("https://lobster.mp/"), "lobster.mp");
  assert.equal(cookieDomainFor("http://127.0.0.1:8787/api/auth/callback/google"), undefined);
  assert.equal(cookieDomainFor("http://localhost:5173/api/auth/callback/google"), undefined);
});

test("trusted origins cover product hosts and local Vite, not arbitrary sites", () => {
  assert.equal(isTrustedOrigin("https://lobster.mp"), true);
  assert.equal(isTrustedOrigin("https://dev.lobster.mp"), true);
  assert.equal(isTrustedOrigin("https://api.lobster.mp"), true);
  assert.equal(isTrustedOrigin("https://abcd.robs-options-slop-dev.pages.dev"), true);
  assert.equal(isTrustedOrigin("http://localhost:5173"), true);
  assert.equal(isTrustedOrigin("https://evil.example"), false);
  const origins = trustedOrigins("https://api.lobster.mp/api/auth/ok", "https://lobster.mp");
  assert.ok(origins.includes("https://api.lobster.mp"));
  assert.ok(origins.includes("https://lobster.mp"));
});

test("compareUserChats is updated_at DESC, then created_at DESC, then chat_id DESC", () => {
  const a = { chat_id: "a", title: "A", created_at: 2, updated_at: 10 };
  const b = { chat_id: "b", title: "B", created_at: 1, updated_at: 20 };
  const c = { chat_id: "c", title: "C", created_at: 9, updated_at: 10 };
  const d = { chat_id: "d", title: "D", created_at: 9, updated_at: 10 };
  assert.deepEqual(
    sortUserChats([a, d, c, b]).map((row) => row.chat_id),
    ["b", "d", "c", "a"],
  );
  assert.ok(compareUserChats(b, a) < 0);
  assert.equal(compareUserChats(a, a), 0);
});
