import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEMA_SAMPLE_PUBLIC_SYMBOL,
  schemaSampleColumn,
  schemaSampleSql,
} from "../src/schema-sample.ts";

test("schemaSampleColumn prefers symbol over ticker", () => {
  assert.equal(schemaSampleColumn([{ name: "symbol" }, { name: "ticker" }]), "symbol");
  assert.equal(schemaSampleColumn([{ name: "Ticker" }]), "ticker");
  assert.equal(schemaSampleColumn([{ name: "series_id" }]), null);
});

test("schemaSampleSql pins high-volume tables to a public liquid name", () => {
  assert.equal(
    schemaSampleSql("ohlc", [{ name: "symbol" }, { name: "date" }]),
    `SELECT * FROM options."ohlc" WHERE symbol = '${SCHEMA_SAMPLE_PUBLIC_SYMBOL}' LIMIT 3`,
  );
  assert.equal(
    schemaSampleSql("etf_holdings", [{ name: "ticker" }, { name: "weight" }]),
    `SELECT * FROM options."etf_holdings" WHERE ticker = '${SCHEMA_SAMPLE_PUBLIC_SYMBOL}' LIMIT 3`,
  );
  assert.equal(
    schemaSampleSql("yields", [{ name: "series_id" }, { name: "value" }]),
    `SELECT * FROM options."yields" LIMIT 3`,
  );
});
