import assert from "node:assert/strict";
import test from "node:test";
import { schemaToPrompt, systemPrompt } from "../src/chat-prompt.ts";
import type { LakeTable } from "../src/chat-sql.ts";

const ewyOhlc: LakeTable = {
  name: "ohlc",
  columns: [
    { name: "symbol", type: "VARCHAR" },
    { name: "date", type: "DATE" },
    { name: "close", type: "DOUBLE" },
  ],
  sample: [
    { symbol: "EWY", date: "2024-09-03", close: 64.1 },
    { symbol: "EWY", date: "2024-09-04", close: 64.4 },
    { symbol: "EWY", date: "2024-09-05", close: 63.9 },
  ],
  row_count: 5_000_000,
};

test("schemaToPrompt omits sample rows and fake enums by default", () => {
  const body = schemaToPrompt([ewyOhlc]);
  assert.match(body, /TABLE options\.ohlc/);
  assert.match(body, /symbol VARCHAR/);
  assert.doesNotMatch(body, /sample rows/);
  assert.doesNotMatch(body, /low-cardinality/);
  assert.doesNotMatch(body, /EWY/);
  assert.doesNotMatch(body, /symbol in \{/);
});

test("schemaToPrompt never infers a universe from a 3-row sample", () => {
  const body = schemaToPrompt([ewyOhlc], { includeSamples: true });
  assert.match(body, /sample rows \(not the universe/);
  assert.match(body, /GROUP BY \/ COUNT\(DISTINCT\)/);
  assert.match(body, /EWY/);
  assert.doesNotMatch(body, /low-cardinality/);
  assert.doesNotMatch(body, /symbol in \{"EWY"\}/);
});

test("schemaToPrompt prints COUNT(DISTINCT) cardinality, not a value list", () => {
  const body = schemaToPrompt([{
    ...ewyOhlc,
    distinct_key: "symbol",
    distinct_count: 412,
  }]);
  assert.match(body, /distinct_symbol: 412/);
  assert.doesNotMatch(body, /EWY/);
  assert.doesNotMatch(body, /symbol in \{/);
});

test("systemPrompt requires GROUP BY / COUNT DISTINCT for table universe", () => {
  const body = systemPrompt("[schema]");
  assert.match(body, /Iceberg LIMIT n without GROUP BY/);
  assert.match(body, /COUNT\(DISTINCT/);
  assert.match(body, /never treat a LIMIT sample as the set/);
  assert.doesNotMatch(body, /sample more/i);
});

test("systemPrompt forces get_market_tape on overview / what's-going-on asks", () => {
  const body = systemPrompt("[schema]");
  assert.match(body, /MUST call get_market_tape first/);
  assert.match(body, /unfiltered option_contracts GROUP BY/);
  assert.doesNotMatch(body, /do not treat those names as flow leaders/);
});
