import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_TOOL_INPUT_SCHEMAS, LAST_FRAME_NAME } from "../src/chat-contract.ts";
import {
  MAX_TOOL_SUMMARY_CHARS,
  buildFrameSummary,
  buildPeriodStatsTable,
  compileFrameQuery,
  jsonPath,
  summarizeResult,
} from "../src/chat-frames.ts";

function placeholders(sql: string): number {
  return [...sql.matchAll(/\?/g)].length;
}

const chain = {
  columns: ["strike", "implied_vol", "type", "expiration"],
  rows: [
    { strike: 90, implied_vol: 0.40, type: "put", expiration: "2026-08-21" },
    { strike: 100, implied_vol: 0.30, type: "call", expiration: "2026-08-21" },
    { strike: 100, implied_vol: 0.32, type: "put", expiration: "2026-08-21" },
    { strike: 110, implied_vol: 0.28, type: "call", expiration: "2026-08-21" },
    { strike: 100, implied_vol: 0.35, type: "call", expiration: "2026-09-18" },
    { strike: 100, implied_vol: null, type: "put", expiration: "2026-09-18" },
  ],
};

test("LAST_FRAME_NAME is the auto-cache alias", () => {
  assert.equal(LAST_FRAME_NAME, "last");
});

test("buildFrameSummary computes full-result numeric stats and string top values", () => {
  const summary = buildFrameSummary(chain.columns, chain.rows);
  assert.equal(summary.implied_vol.type, "number");
  assert.equal(summary.implied_vol.count, 5);
  assert.equal(summary.implied_vol.nulls, 1);
  assert.equal(summary.implied_vol.min, 0.28);
  assert.equal(summary.implied_vol.max, 0.40);
  assert.ok(summary.implied_vol.mean !== undefined);
  assert.ok(Math.abs(summary.implied_vol.mean! - (0.40 + 0.30 + 0.32 + 0.28 + 0.35) / 5) < 1e-12);
  assert.equal(summary.implied_vol.p50, 0.32);
  assert.equal(summary.type.type, "string");
  assert.deepEqual(summary.type.top, [
    { value: "call", n: 3 },
    { value: "put", n: 3 },
  ]);
});

test("summarizeResult attaches stats, head/tail, and extrema — not a 30-row dump", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    strike: 80 + i,
    implied_vol: 0.20 + i * 0.01,
    type: i % 2 === 0 ? "call" : "put",
  }));
  const text = summarizeResult({
    columns: ["strike", "implied_vol", "type"],
    rows,
    row_count: 40,
  }, ["Cached as frame 'last' (40 rows)."]);
  assert.match(text, /Cached as frame 'last'/);
  assert.match(text, /Stats:/);
  assert.match(text, /implied_vol: number count=40 nulls=0/);
  assert.match(text, /p50=/);
  assert.match(text, /type: string count=40 nulls=0 top=\{call:20, put:20\}/);
  assert.match(text, /head \(5\):/);
  assert.match(text, /tail \(5\):/);
  assert.match(text, /extrema:/);
  assert.match(text, /strike min:/);
  assert.match(text, /strike max:/);
  assert.doesNotMatch(text, /showing 30 of/);
  assert.doesNotMatch(text, /90 \| 0\.3000 \| call/, "must not dump the middle of a 40-row result as a 30-row preview");
});

test("summarizeResult is capped at MAX_TOOL_SUMMARY_CHARS", () => {
  const columns = Array.from({ length: 80 }, (_, i) => `col_${i}`);
  const rows = Array.from({ length: 200 }, (_, r) => {
    const row: Record<string, unknown> = {};
    for (const column of columns) row[column] = `value_${r}_${column}_${"x".repeat(40)}`;
    return row;
  });
  const text = summarizeResult({ columns, rows, row_count: rows.length });
  assert.ok(text.length <= MAX_TOOL_SUMMARY_CHARS);
  assert.match(text, /^Columns:/);
  assert.match(text, /Stats:/);
});

test("buildPeriodStatsTable rolls multi-ticker OHLC into ranked period returns", () => {
  const columns = ["symbol", "date", "close"];
  const rows = [
    { symbol: "AAA", date: "2024-01-02", close: 100 },
    { symbol: "AAA", date: "2024-01-03", close: 110 },
    { symbol: "AAA", date: "2024-01-04", close: 121 },
    { symbol: "BBB", date: "2024-01-02", close: 50 },
    { symbol: "BBB", date: "2024-01-03", close: 40 },
    { symbol: "BBB", date: "2024-01-04", close: 35 },
    { symbol: "CCC", date: "2024-01-02", close: 200 },
    { symbol: "CCC", date: "2024-01-03", close: 170 }, // -15% crash
    { symbol: "CCC", date: "2024-01-04", close: 180 },
  ];
  const table = buildPeriodStatsTable(columns, rows);
  assert.ok(table);
  assert.equal(table!.seriesColumn, "symbol");
  assert.equal(table!.rows.length, 3);
  assert.equal(table!.rows[0]!.series, "AAA");
  assert.ok(Math.abs(table!.rows[0]!.totalReturnPct - 21) < 1e-9);
  assert.equal(table!.rows[2]!.series, "BBB");
  const ccc = table!.rows.find((r) => r.series === "CCC")!;
  assert.equal(ccc.sharpDropDate, "2024-01-03");
});

test("summarizeResult appends period performance for OHLC panels, not option chains", () => {
  const ohlcRows = [
    { ticker: "AAA", date: "2024-01-02", close: 100 },
    { ticker: "AAA", date: "2024-01-03", close: 105 },
    { ticker: "AAA", date: "2024-01-04", close: 110 },
    { ticker: "BBB", date: "2024-01-02", close: 80 },
    { ticker: "BBB", date: "2024-01-03", close: 78 },
    { ticker: "BBB", date: "2024-01-04", close: 76 },
  ];
  const ohlcText = summarizeResult({
    columns: ["ticker", "date", "close"],
    rows: ohlcRows,
    row_count: ohlcRows.length,
  });
  assert.match(ohlcText, /Period performance \(by ticker/);
  assert.match(ohlcText, /total_return_pct/);
  assert.match(ohlcText, /AAA \|/);
  assert.match(ohlcText, /BBB \|/);

  const chainText = summarizeResult({
    columns: chain.columns,
    rows: chain.rows,
    row_count: chain.rows.length,
  });
  assert.doesNotMatch(chainText, /Period performance/);
  assert.equal(buildPeriodStatsTable(chain.columns, chain.rows), null);
});

test("compileFrameQuery filter path stays parameterized and placeholder-aligned", () => {
  const compiled = compileFrameQuery(chain.columns, "last", {
    where: "type == 'call' && strike >= 100",
    sort: "implied_vol",
    project: ["strike", "implied_vol"],
    limit: 10,
  });
  assert.equal(placeholders(compiled.sql), compiled.values.length);
  assert.equal(compiled.sql.includes("AVG("), false);
  assert.equal(compiled.sql.includes("GROUP BY"), false);
  assert.match(compiled.sql, /json_extract\(row_json, \?\)/);
  assert.match(compiled.sql, /ORDER BY .*row_index ASC/);
  assert.deepEqual(compiled.columns, ["strike", "implied_vol"]);
  assert.equal(compiled.values[compiled.values.length - 1], 10);
  assert.ok(compiled.values.includes("last"));
  assert.ok(compiled.values.includes(jsonPath("type")));
  assert.ok(compiled.values.includes("call"));
});

test("compileFrameQuery grouped reductions use AVG/SUM/COUNT on json_extract", () => {
  const compiled = compileFrameQuery(chain.columns, "last", {
    where: "type == 'call'",
    group_by: ["expiration"],
    aggregations: [
      { fn: "avg", column: "implied_vol" },
      { fn: "min", column: "strike", as: "atm_strike" },
      { fn: "count" },
    ],
    sort: "avg_implied_vol",
    limit: 20,
  });
  assert.equal(placeholders(compiled.sql), compiled.values.length);
  assert.match(compiled.sql, /AVG\(CAST\(json_extract\(row_json, \?\) AS REAL\)\)/);
  assert.match(compiled.sql, /MIN\(CAST\(json_extract\(row_json, \?\) AS REAL\)\)/);
  assert.match(compiled.sql, /COUNT\(\*\)/);
  assert.match(compiled.sql, /GROUP BY json_extract\(row_json, \?\)/);
  assert.match(compiled.sql, /ORDER BY "avg_implied_vol"/);
  assert.deepEqual(compiled.columns, ["expiration", "avg_implied_vol", "atm_strike", "count"]);
  assert.doesNotMatch(compiled.sql, /FROM options\./);
});

test("compileFrameQuery whole-frame count/avg has no GROUP BY", () => {
  const compiled = compileFrameQuery(chain.columns, "last", {
    aggregations: [{ fn: "avg", column: "implied_vol" }, { fn: "count" }],
  });
  assert.equal(placeholders(compiled.sql), compiled.values.length);
  assert.equal(compiled.sql.includes("GROUP BY"), false);
  assert.deepEqual(compiled.columns, ["avg_implied_vol", "count"]);
});

test("compileFrameQuery rejects group_by without aggregations and unknown columns", () => {
  assert.throws(
    () => compileFrameQuery(chain.columns, "last", { group_by: ["expiration"] }),
    /group_by requires aggregations/,
  );
  assert.throws(
    () => compileFrameQuery(chain.columns, "last", { aggregations: [{ fn: "avg" }] }),
    /avg requires a column/,
  );
  assert.throws(
    () => compileFrameQuery(chain.columns, "last", { aggregations: [{ fn: "avg", column: "not_a_col" }] }),
    /unknown column/,
  );
});

test("filter_frame schema accepts aggregations on a cached frame", () => {
  const parsed = CHAT_TOOL_INPUT_SCHEMAS.filter_frame.parse({
    frame: LAST_FRAME_NAME,
    where: "type == 'call'",
    group_by: ["expiration"],
    aggregations: [{ fn: "avg", column: "implied_vol", as: "atm_iv" }],
  });
  assert.equal(parsed.frame, "last");
  assert.equal(parsed.aggregations?.[0]?.fn, "avg");
  assert.deepEqual(parsed.group_by, ["expiration"]);
});
