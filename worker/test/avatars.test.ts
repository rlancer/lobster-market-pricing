import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeSvg, resolveAvatarMime } from "../src/avatars.ts";

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

test("assertSafeSvg accepts a plain vector mark", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#0f0"/></svg>`;
  assert.deepEqual(assertSafeSvg(bytes(svg)), { ok: true });
});

test("assertSafeSvg rejects script and event handlers", () => {
  assert.equal(assertSafeSvg(bytes(`<svg><script>alert(1)</script></svg>`)).ok, false);
  assert.equal(assertSafeSvg(bytes(`<svg onload="alert(1)"></svg>`)).ok, false);
  assert.equal(assertSafeSvg(bytes(`<svg><a href="javascript:alert(1)"/></svg>`)).ok, false);
  assert.equal(assertSafeSvg(bytes(`not svg`)).ok, false);
});

test("resolveAvatarMime sniffs SVG when Content-Type is missing", () => {
  const svg = bytes(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`);
  assert.equal(resolveAvatarMime("application/octet-stream", svg), "image/svg+xml");
  assert.equal(resolveAvatarMime("image/svg+xml", svg), "image/svg+xml");
  assert.equal(resolveAvatarMime("image/png", bytes("not-png")), "image/png");
  assert.equal(resolveAvatarMime("text/plain", bytes("hello")), null);
});
