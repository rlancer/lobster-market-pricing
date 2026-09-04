import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeEmailHtml,
  isLikelyEmail,
  resolveEmailTestRecipient,
  sendAdminEmailTest,
  EMAIL_TEST_FROM,
  EMAIL_TEST_SUBJECT,
} from "../src/admin-email-test.ts";

test("isLikelyEmail accepts basic addresses and rejects junk", () => {
  assert.equal(isLikelyEmail("robert.lancer@gmail.com"), true);
  assert.equal(isLikelyEmail("  a@b.co  "), true);
  assert.equal(isLikelyEmail(""), false);
  assert.equal(isLikelyEmail("not-an-email"), false);
  assert.equal(isLikelyEmail("a @b.com"), false);
});

test("escapeEmailHtml escapes angle brackets and ampersands", () => {
  assert.equal(escapeEmailHtml("a<b>&c"), "a&lt;b&gt;&amp;c");
});

test("resolveEmailTestRecipient prefers session email", () => {
  const got = resolveEmailTestRecipient({
    sessionEmail: "robert.lancer@gmail.com",
    bodyTo: "other@example.com",
    tokenAuthorized: true,
  });
  assert.deepEqual(got, { ok: true, to: "robert.lancer@gmail.com" });
});

test("resolveEmailTestRecipient allows ADMIN_TOKEN + body.to", () => {
  const got = resolveEmailTestRecipient({
    sessionEmail: null,
    bodyTo: "ops@example.com",
    tokenAuthorized: true,
  });
  assert.deepEqual(got, { ok: true, to: "ops@example.com" });
});

test("resolveEmailTestRecipient rejects token without to", () => {
  const got = resolveEmailTestRecipient({
    sessionEmail: null,
    bodyTo: undefined,
    tokenAuthorized: true,
  });
  assert.equal(got.ok, false);
  if (!got.ok) assert.equal(got.status, 400);
});

test("sendAdminEmailTest builds Lobster noreply payload", async () => {
  let captured: unknown;
  const email = {
    async send(message: unknown) {
      captured = message;
      return { messageId: "mid-1" };
    },
  };
  const result = await sendAdminEmailTest(email, "robert.lancer@gmail.com");
  assert.equal(result.messageId, "mid-1");
  assert.deepEqual(captured, {
    to: "robert.lancer@gmail.com",
    from: EMAIL_TEST_FROM,
    subject: EMAIL_TEST_SUBJECT,
    text: "This is a Cloudflare Email Service smoke test for robert.lancer@gmail.com.",
    html:
      "<p>This is a Cloudflare Email Service smoke test for <strong>robert.lancer@gmail.com</strong>.</p>",
  });
  assert.equal(EMAIL_TEST_FROM.name, "The Lobster 😎");
  assert.match(EMAIL_TEST_SUBJECT, /The Lobster/);
});
