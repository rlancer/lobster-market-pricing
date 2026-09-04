import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToEmailHtml } from "../src/email-markdown.ts";
import { buildUserBotAlertEmail } from "../src/user-bot-email.ts";

test("markdownToEmailHtml renders headings, lists, and emphasis", () => {
  const html = markdownToEmailHtml([
    "## Risk takeaway",
    "",
    "Trim the **NVDA** calls before Friday.",
    "",
    "- Cut delta",
    "- Keep hedges",
  ].join("\n"));
  assert.match(html, /<h2[^>]*>Risk takeaway<\/h2>/);
  assert.match(html, /<strong>NVDA<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>Cut delta<\/li>/);
  assert.doesNotMatch(html, /## Risk/);
  assert.doesNotMatch(html, /\*\*NVDA\*\*/);
});

test("markdownToEmailHtml escapes raw HTML and blocks unsafe links", () => {
  const html = markdownToEmailHtml(
    'Hello <script>alert(1)</script> and [x](javascript:alert(1)) plus [ok](https://lobster.mp/chat/1).',
  );
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /href="https:\/\/lobster\.mp\/chat\/1"/);
});

test("alert email HTML renders briefing markdown instead of raw markers", () => {
  const built = buildUserBotAlertEmail({
    botName: "Portfolio risk",
    briefing: "## Action\n\nSell the **SPY** puts.",
    chatUrl: "https://lobster.mp/chat/abc",
  });
  assert.match(built.html, /<h2[^>]*>Action<\/h2>/);
  assert.match(built.html, /<strong>SPY<\/strong>/);
  assert.doesNotMatch(built.html, /## Action/);
  assert.doesNotMatch(built.html, /\*\*SPY\*\*/);
  assert.match(built.text, /## Action/);
  assert.match(built.html, /Open the briefing/);
});
