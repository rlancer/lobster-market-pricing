import assert from "node:assert/strict";
import test from "node:test";
import {
  cookieDomainFor,
  impersonationAllowed,
  isDevImpersonationHost,
  isTrustedOrigin,
  parseDevAsEmail,
  trustedOrigins,
} from "../src/auth.ts";
import {
  clipTitle,
  chatAgentChatId,
  compareUserChats,
  historyTitle,
  parseChatId,
  shareDisplayTitle,
  sortUserChats,
  titleFromMessages,
} from "../src/user-chats.ts";
import { resolveImpersonationEmail } from "../src/dev-session.ts";

test("parseChatId accepts UUIDs and rejects junk", () => {
  const id = "3b1d0a2e-7c4f-4a11-9f2d-8e6c1b0a9d77";
  assert.equal(parseChatId(id), id);
  assert.equal(parseChatId(` ${id} `), id);
  assert.equal(parseChatId("not-a-uuid"), null);
  assert.equal(parseChatId(""), null);
  assert.equal(parseChatId(null), null);
});

test("chatAgentChatId reads the Agent instance name", () => {
  const id = "3b1d0a2e-7c4f-4a11-9f2d-8e6c1b0a9d77";
  assert.equal(chatAgentChatId(`/agents/copilot-agent/${id}`), id);
  assert.equal(chatAgentChatId(`/agents/copilot-agent/${id}/get-messages`), id);
  assert.equal(chatAgentChatId("/api/chats"), null);
  assert.equal(chatAgentChatId("/agents/copilot-agent/nope"), null);
});

test("historyTitle rejects blank titles so Untitled shells stay out of the list", () => {
  assert.equal(historyTitle(null), null);
  assert.equal(historyTitle(undefined), null);
  assert.equal(historyTitle(""), null);
  assert.equal(historyTitle("   "), null);
  assert.equal(historyTitle("Chart NVDA"), "Chart NVDA");
  assert.equal(historyTitle("  Chart NVDA  "), "Chart NVDA");
});

test("clipTitle prefers the opening sentence and never cuts mid-word", () => {
  const prompt =
    "Hourly market overview: what's happening right now? Lead with SPX/QQQ/IWM posture, sector leadership or rotation, and the unusual options flow or single-name catalysts that explain the tape. Close with a sharp desk takeaway.";
  assert.equal(clipTitle(prompt), "Hourly market overview: what's happening right now?");

  const longWords =
    "Lead with SPX QQQ IWM posture sector leadership or rotation and the unusual options flow or single-name catalysts that explain the tape close with a sharp desk takeaway today";
  const clipped = clipTitle(longWords);
  assert.ok(clipped.endsWith("…"));
  assert.ok(clipped.length <= 120);
  // Hard slice(0, 120) of the bot prompt ended on "and th" — word break must not.
  assert.equal(clipped.endsWith(" th…"), false);
  assert.match(clipped, /\s\S+…$/);
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
  assert.ok(titleFromMessages([{ role: "user", content: long }])?.endsWith("…"));
});

test("shareDisplayTitle heals mid-word stored titles from the first user turn", () => {
  const prompt =
    "Hourly market overview: what's happening right now? Lead with SPX/QQQ/IWM posture, sector leadership or rotation, and the unusual options flow or single-name catalysts that explain the tape. Close with a sharp desk takeaway.";
  const truncated = prompt.slice(0, 120);
  assert.equal(truncated.endsWith("and th"), true);
  assert.equal(
    shareDisplayTitle([{ role: "user", content: prompt }, { role: "assistant", content: "Tape…" }], truncated),
    "Hourly market overview: what's happening right now?",
  );
  assert.equal(shareDisplayTitle([], truncated), clipTitle(truncated));
  assert.equal(
    shareDisplayTitle([{ role: "user", content: prompt }], "SPX soft; QQQ leads"),
    "SPX soft; QQQ leads",
  );
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

test("dev impersonation is preview-only and admin-email-only", () => {
  assert.equal(isDevImpersonationHost("api-dev.lobster.mp"), true);
  assert.equal(isDevImpersonationHost("localhost"), true);
  assert.equal(isDevImpersonationHost("screener-api-dev.robertlancer.workers.dev"), true);
  assert.equal(isDevImpersonationHost("preview.screener-api-dev.workers.dev"), true);
  assert.equal(isDevImpersonationHost("screener-api.robertlancer.workers.dev"), false);
  assert.equal(isDevImpersonationHost("api.lobster.mp"), false);
  assert.equal(isDevImpersonationHost("lobster.mp"), false);
  assert.equal(impersonationAllowed({ ALLOW_DEV_IMPERSONATION: "1" }, "api-dev.lobster.mp"), true);
  assert.equal(impersonationAllowed({ ALLOW_DEV_IMPERSONATION: "1" }, "api.lobster.mp"), false);
  assert.equal(impersonationAllowed({}, "api-dev.lobster.mp"), false);
  assert.equal(impersonationAllowed({ ALLOW_DEV_IMPERSONATION: "0" }, "api-dev.lobster.mp"), false);
  assert.equal(parseDevAsEmail("robert.lancer@gmail.com"), "robert.lancer@gmail.com");
  assert.equal(parseDevAsEmail("  Robert.Lancer@gmail.com  "), "robert.lancer@gmail.com");
  assert.equal(parseDevAsEmail("stranger@example.com"), null);
  assert.equal(resolveImpersonationEmail(undefined, "robert.lancer@gmail.com"), "robert.lancer@gmail.com");
  assert.equal(resolveImpersonationEmail("stranger@example.com", "robert.lancer@gmail.com"), null);
});
