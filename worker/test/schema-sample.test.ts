import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEMA_SAMPLE_PUBLIC_SYMBOL,
  schemaCountSql,
  schemaSampleColumn,
  schemaSampleSql,
  schemaUniverseColumn,
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

test("schemaUniverseColumn prefers symbol, then ticker, then series ids", () => {
  assert.equal(schemaUniverseColumn([{ name: "symbol" }, { name: "ticker" }]), "symbol");
  assert.equal(schemaUniverseColumn([{ name: "ticker" }]), "ticker");
  assert.equal(schemaUniverseColumn([{ name: "series_id" }]), "series_id");
  assert.equal(schemaUniverseColumn([{ name: "series_ticker" }]), "series_ticker");
  assert.equal(schemaUniverseColumn([{ name: "value" }]), null);
});

test("schemaCountSql uses COUNT(DISTINCT) for the universe key", () => {
  assert.equal(
    schemaCountSql("option_contracts", [{ name: "symbol" }, { name: "volume" }]),
    `SELECT COUNT(*) AS n, COUNT(DISTINCT symbol) AS n_keys FROM options."option_contracts"`,
  );
  assert.equal(
    schemaCountSql("yields", [{ name: "series_id" }, { name: "value" }]),
    `SELECT COUNT(*) AS n, COUNT(DISTINCT series_id) AS n_keys FROM options."yields"`,
  );
  assert.equal(
    schemaCountSql("econ_calendar", [{ name: "title" }, { name: "date" }]),
    `SELECT COUNT(*) AS n FROM options."econ_calendar"`,
  );
});
