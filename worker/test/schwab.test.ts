import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthorizeUrl,
  createOAuthState,
  sanitizeReturnTo,
  schwabConfigured,
  schwabRedirectUri,
  verifyOAuthState,
  SCHWAB_AUTHORIZE_URL,
} from "../src/schwab.ts";

test("schwabConfigured requires both client id and secret", () => {
  assert.equal(schwabConfigured({ SCHEMA_DB: {} as D1Database }), false);
  assert.equal(schwabConfigured({ SCHEMA_DB: {} as D1Database, SCHWAB_CLIENT_ID: "id" }), false);
  assert.equal(
    schwabConfigured({
      SCHEMA_DB: {} as D1Database,
      SCHWAB_CLIENT_ID: "id",
      SCHWAB_CLIENT_SECRET: "secret",
    }),
    true,
  );
});

test("schwabRedirectUri prefers override then request origin", () => {
  assert.equal(
    schwabRedirectUri(
      { SCHEMA_DB: {} as D1Database, SCHWAB_REDIRECT_URI: "https://api.lobster.mp/api/schwab/callback" },
      "https://api-dev.lobster.mp/api/schwab/connect",
    ),
    "https://api.lobster.mp/api/schwab/callback",
  );
  assert.equal(
    schwabRedirectUri({ SCHEMA_DB: {} as D1Database }, "https://api-dev.lobster.mp/api/schwab/connect"),
    "https://api-dev.lobster.mp/api/schwab/callback",
  );
});

test("buildAuthorizeUrl includes response_type and state", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "app-key",
      redirectUri: "https://api.lobster.mp/api/schwab/callback",
      state: "abc.def",
    }),
  );
  assert.equal(url.origin + url.pathname, SCHWAB_AUTHORIZE_URL);
  assert.equal(url.searchParams.get("client_id"), "app-key");
  assert.equal(url.searchParams.get("redirect_uri"), "https://api.lobster.mp/api/schwab/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "api");
  assert.equal(url.searchParams.get("state"), "abc.def");
});

test("sanitizeReturnTo only allows trusted origins and /account|/portfolio", () => {
  assert.equal(
    sanitizeReturnTo("https://lobster.mp/chat/xyz?x=1", "https://dev.lobster.mp"),
    "https://lobster.mp/account",
  );
  assert.equal(
    sanitizeReturnTo("https://lobster.mp/portfolio?x=1", "https://dev.lobster.mp"),
    "https://lobster.mp/portfolio",
  );
  assert.equal(
    sanitizeReturnTo("https://evil.example/account", "https://dev.lobster.mp"),
    "https://dev.lobster.mp/account",
  );
  assert.equal(sanitizeReturnTo(null, "https://dev.lobster.mp"), "https://dev.lobster.mp/account");
});

test("createOAuthState round-trips and rejects tampering / expiry", async () => {
  const secret = "test-better-auth-secret-for-schwab-state";
  const state = await createOAuthState(secret, "user-1", "https://lobster.mp/account", 1_700_000_000_000);
  const ok = await verifyOAuthState(secret, state, 1_700_000_000_000);
  assert.deepEqual(
    { userId: ok?.userId, returnTo: ok?.returnTo },
    { userId: "user-1", returnTo: "https://lobster.mp/account" },
  );

  const tampered = state.slice(0, -4) + "xxxx";
  assert.equal(await verifyOAuthState(secret, tampered, 1_700_000_000_000), null);
  assert.equal(await verifyOAuthState(secret, state, 1_700_000_000_000 + 16 * 60 * 1000), null);
});
