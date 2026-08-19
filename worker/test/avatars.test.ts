import assert from "node:assert/strict";
import test from "node:test";
import {
  AVATAR_D1_KEY,
  assertSafeSvg,
  avatarUrlFor,
  d1BlobToUint8Array,
  resolveAvatarMime,
  sniffImageContentType,
} from "../src/avatars.ts";

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

test("sniffImageContentType recognizes common image magic bytes", () => {
  assert.equal(sniffImageContentType(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(
    sniffImageContentType(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    "image/png",
  );
  assert.equal(
    sniffImageContentType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>")),
    "image/svg+xml",
  );
  assert.equal(sniffImageContentType(Uint8Array.of(0x00, 0x01, 0x02)), null);
});

test("avatarUrlFor uses the D1 sentinel and version query", () => {
  assert.equal(avatarUrlFor("u1", null), null);
  assert.equal(avatarUrlFor("u1", AVATAR_D1_KEY), "/api/avatars/u1");
  assert.equal(avatarUrlFor("u1", AVATAR_D1_KEY, 99), "/api/avatars/u1?v=99");
});

test("d1BlobToUint8Array coerces D1 number arrays and buffers", () => {
  const fromArray = d1BlobToUint8Array([255, 216, 255]);
  assert.ok(fromArray);
  assert.deepEqual([...fromArray!], [255, 216, 255]);

  const buf = Uint8Array.of(1, 2, 3).buffer;
  const fromBuf = d1BlobToUint8Array(buf);
  assert.ok(fromBuf);
  assert.deepEqual([...fromBuf!], [1, 2, 3]);

  assert.equal(d1BlobToUint8Array(null), null);
  assert.equal(d1BlobToUint8Array([]), null);
  assert.equal(d1BlobToUint8Array(new ArrayBuffer(0)), null);
});
