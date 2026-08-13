import assert from "node:assert/strict";
import test from "node:test";
import { dropSmokeTestRows, isSmokeTestRow } from "../src/smoke-test.ts";

test("isSmokeTestRow catches ZZZ / 2099-01-01 / probe run_id", () => {
  assert.equal(isSmokeTestRow({ symbol: "ZZZ", open_interest: null }), true);
  assert.equal(isSmokeTestRow({ ticker: "zzz", spot_price: 1 }), true);
  assert.equal(isSmokeTestRow({ as_of_date: "2099-01-01" }), true);
  assert.equal(isSmokeTestRow({ expiration: "2099-01-01", type: "call" }), true);
  assert.equal(isSmokeTestRow({ fetched_at: "2099-01-01T00:00:00+00:00" }), true);
  assert.equal(isSmokeTestRow({ run_id: "probe-abc" }), true);
  assert.equal(isSmokeTestRow({ "max(as_of_date)": "2099-01-01" }), true);
});

test("isSmokeTestRow keeps real market rows", () => {
  assert.equal(isSmokeTestRow({ symbol: "SPY", as_of_date: "2026-08-12", open_interest: 1 }), false);
  assert.equal(isSmokeTestRow({ symbol: "NVDA", expiration: "2026-09-18" }), false);
  assert.deepEqual(dropSmokeTestRows([
    { symbol: "ZZZ", as_of_date: "2099-01-01" },
    { symbol: "SPY", as_of_date: "2026-08-12" },
  ]).map((row) => row.symbol), ["SPY"]);
});
