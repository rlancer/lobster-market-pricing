import assert from "node:assert/strict";
import test from "node:test";
import { parseDisplayName, parseHandle, publicName, suggestHandle } from "../src/profiles.ts";

test("parseHandle lowercases, strips padding, and accepts a letter-led slug", () => {
  assert.deepEqual(parseHandle("Rob"), { ok: true, handle: "rob" });
  assert.deepEqual(parseHandle("  nvda  "), { ok: true, handle: "nvda" });
  assert.deepEqual(parseHandle("a12"), { ok: true, handle: "a12" });
  assert.deepEqual(parseHandle("abcdefghijabcdefghijabcd"), { ok: true, handle: "abcdefghijabcdefghijabcd" });
});

test("parseHandle rejects blank, short, long, and non-slug input", () => {
  assert.equal(parseHandle(null).ok, false);
  assert.equal(parseHandle("").ok, false);
  assert.equal(parseHandle("   ").ok, false);
  assert.equal(parseHandle("ab").ok, false);
  assert.equal(parseHandle("abcdefghijabcdefghijabcde").ok, false);
  assert.equal(parseHandle("1rob").ok, false);
  assert.equal(parseHandle("rob_lancer").ok, false);
  assert.equal(parseHandle("rob-lancer").ok, false);
  assert.equal(parseHandle("rob.lancer").ok, false);
  assert.equal(parseHandle("rob lancer").ok, false);
  assert.equal(parseHandle("@rob").ok, false);
  for (const result of [
    parseHandle(null),
    parseHandle(""),
    parseHandle("ab"),
    parseHandle("1rob"),
    parseHandle("rob_lancer"),
  ]) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 400);
  }
});

test("parseHandle blocks reserved product slugs", () => {
  for (const reserved of ["api", "chat", "docs", "share", "admin", "lobster", "avatars"]) {
    const result = parseHandle(reserved);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.match(result.error, /reserved/);
    }
  }
});

test("suggestHandle prefers the email local part, then the name", () => {
  assert.equal(suggestHandle("rlancer@gmail.com", "Rob Lancer"), "rlancer");
  assert.equal(suggestHandle("rob.lancer@gmail.com", null), "roblancer");
  assert.equal(suggestHandle("123rob@gmail.com", "Ada"), "rob");
  assert.equal(suggestHandle("admin@gmail.com", "Ada Lovelace"), "adalovelace");
  assert.equal(suggestHandle("admin@gmail.com", "Me"), null);
  assert.equal(suggestHandle(null, null), null);
});

test("parseDisplayName trims, collapses spaces, and clears blanks", () => {
  assert.deepEqual(parseDisplayName("  Rob   Lancer "), { ok: true, display_name: "Rob Lancer" });
  assert.deepEqual(parseDisplayName(""), { ok: true, display_name: null });
  assert.deepEqual(parseDisplayName("   "), { ok: true, display_name: null });
  assert.deepEqual(parseDisplayName(null), { ok: true, display_name: null });
  assert.equal(parseDisplayName(12).ok, false);
  assert.equal(parseDisplayName("x".repeat(81)).ok, false);
});

test("publicName prefers product display_name over Google name", () => {
  assert.equal(publicName("Ada", "Google Name"), "Ada");
  assert.equal(publicName(null, "Google Name"), "Google Name");
  assert.equal(publicName("  ", "Google Name"), "Google Name");
  assert.equal(publicName(null, null), "Member");
});
