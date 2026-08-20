import assert from "node:assert/strict";
import test from "node:test";
import {
  clampUserListLimit,
  normalizeAuthCreatedAt,
  rowToAdminUser,
  type AdminUserRow,
} from "../src/admin-users.ts";

test("clampUserListLimit defaults and caps", () => {
  assert.equal(clampUserListLimit(undefined), 500);
  assert.equal(clampUserListLimit(-1), 500);
  assert.equal(clampUserListLimit(0), 500);
  assert.equal(clampUserListLimit(50), 50);
  assert.equal(clampUserListLimit(9999), 2000);
  assert.equal(clampUserListLimit("100"), 100);
});

test("normalizeAuthCreatedAt accepts ISO, epoch ms, and epoch seconds", () => {
  assert.equal(normalizeAuthCreatedAt("2024-06-01T12:00:00.000Z"), "2024-06-01T12:00:00.000Z");
  assert.equal(normalizeAuthCreatedAt(1_717_243_200_000), "2024-06-01T12:00:00.000Z");
  assert.equal(normalizeAuthCreatedAt(1_717_243_200), "2024-06-01T12:00:00.000Z");
  assert.equal(normalizeAuthCreatedAt(new Date("2024-06-01T12:00:00.000Z")), "2024-06-01T12:00:00.000Z");
  assert.equal(normalizeAuthCreatedAt(""), "");
});

test("rowToAdminUser maps profile fields and admin flag", () => {
  const row: AdminUserRow = {
    id: "u1",
    email: "robert.lancer@gmail.com",
    name: "Rob",
    image: "https://example.com/g.jpg",
    emailVerified: 1,
    createdAt: "2024-06-01T12:00:00.000Z",
    handle: "thelobster",
    display_name: "The Lobster",
    avatar_key: "av1",
    profile_updated_at: 1_700_000_000_000,
    profile_created_at: 1_700_000_000_000,
    chat_count: 3,
  };
  const user = rowToAdminUser(row);
  assert.equal(user.is_admin, true);
  assert.equal(user.email_verified, true);
  assert.equal(user.handle, "thelobster");
  assert.equal(user.public_name, "The Lobster");
  assert.equal(user.chat_count, 3);
  assert.equal(user.avatar_url, "/api/avatars/u1?v=1700000000000");
});

test("rowToAdminUser falls back to Google name without profile", () => {
  const user = rowToAdminUser({
    id: "u2",
    email: "someone@example.com",
    name: "Sam Example",
    image: null,
    emailVerified: 0,
    createdAt: 1_717_243_200_000,
    handle: null,
    display_name: null,
    avatar_key: null,
    profile_updated_at: null,
    profile_created_at: null,
    chat_count: null,
  });
  assert.equal(user.is_admin, false);
  assert.equal(user.email_verified, false);
  assert.equal(user.handle, null);
  assert.equal(user.public_name, "Sam Example");
  assert.equal(user.avatar_url, null);
  assert.equal(user.chat_count, 0);
  assert.equal(user.created_at, "2024-06-01T12:00:00.000Z");
});
