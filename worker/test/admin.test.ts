import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_EMAILS, isAdminEmail } from "../src/admin.ts";

test("ADMIN_EMAILS includes the owner account", () => {
  assert.ok(ADMIN_EMAILS.includes("robert.lancer@gmail.com"));
});

test("isAdminEmail accepts the owner email case-insensitively", () => {
  assert.equal(isAdminEmail("robert.lancer@gmail.com"), true);
  assert.equal(isAdminEmail("Robert.Lancer@gmail.com"), true);
  assert.equal(isAdminEmail("  robert.lancer@gmail.com  "), true);
});

test("isAdminEmail rejects non-admins and empty input", () => {
  assert.equal(isAdminEmail(null), false);
  assert.equal(isAdminEmail(undefined), false);
  assert.equal(isAdminEmail(""), false);
  assert.equal(isAdminEmail("someone@example.com"), false);
  assert.equal(isAdminEmail("robert.lancer@example.com"), false);
});
