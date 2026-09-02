import assert from "node:assert/strict";
import test from "node:test";
import {
  HELLO_FORWARD_TO,
  HELLO_INBOUND,
  handleInboundEmail,
  normalizeInboundRecipient,
  resolveInboundForward,
} from "../src/inbound-email.ts";

test("normalizeInboundRecipient lowercases and strips display names", () => {
  assert.equal(normalizeInboundRecipient("Hello@Lobster.MP"), HELLO_INBOUND);
  assert.equal(
    normalizeInboundRecipient("Someone <hello@lobster.mp>"),
    HELLO_INBOUND,
  );
});

test("normalizeInboundRecipient strips +subaddress for allowlist matching", () => {
  assert.equal(
    normalizeInboundRecipient("hello+press@lobster.mp"),
    HELLO_INBOUND,
  );
});

test("resolveInboundForward maps hello@ to owner Gmail", () => {
  assert.equal(resolveInboundForward(HELLO_INBOUND), HELLO_FORWARD_TO);
  assert.equal(resolveInboundForward("HELLO@lobster.mp"), HELLO_FORWARD_TO);
  assert.equal(resolveInboundForward("unknown@lobster.mp"), null);
});

test("handleInboundEmail forwards hello@ with X-Original-Recipient", async () => {
  let forwardedTo: string | null = null;
  let forwardedHeaders: Headers | null = null;
  let rejected: string | null = null;

  const outcome = await handleInboundEmail({
    from: "sender@example.com",
    to: "hello@lobster.mp",
    headers: new Headers({ subject: "Hi" }),
    setReject(reason) {
      rejected = reason;
    },
    async forward(rcptTo, headers) {
      forwardedTo = rcptTo;
      forwardedHeaders = headers ?? null;
    },
  });

  assert.equal(outcome, "forwarded");
  assert.equal(forwardedTo, HELLO_FORWARD_TO);
  assert.equal(forwardedHeaders?.get("X-Original-Recipient"), "hello@lobster.mp");
  assert.equal(rejected, null);
});

test("handleInboundEmail rejects unknown recipients", async () => {
  let rejected: string | null = null;
  let forwarded = false;

  const outcome = await handleInboundEmail({
    from: "sender@example.com",
    to: "noreply@lobster.mp",
    headers: new Headers(),
    setReject(reason) {
      rejected = reason;
    },
    async forward() {
      forwarded = true;
    },
  });

  assert.equal(outcome, "rejected");
  assert.equal(rejected, "Address not accepted");
  assert.equal(forwarded, false);
});
