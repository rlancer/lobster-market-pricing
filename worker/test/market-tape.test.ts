import assert from "node:assert/strict";
import test from "node:test";
import {
  FLOW_COVERAGE_MIN_SYMBOLS,
  TAPE_FLOW_SYMBOLS,
  formatMarketTapeSummary,
  isMarketOverviewAsk,
  loadMarketTape,
  parseTapeFlowRows,
  tapeCoverageSql,
  tapeFlowSql,
  type MarketTape,
} from "../src/market-tape.ts";

const NOWLOBSTER =
  "Hourly market overview: what's happening right now? Lead with SPX/QQQ/IWM posture, sector leadership or rotation, and the unusual options flow or single-name catalysts that explain the tape. Close with a sharp desk takeaway.";

test("isMarketOverviewAsk matches hourly / what's-going-on prompts", () => {
  assert.equal(isMarketOverviewAsk(NOWLOBSTER), true);
  assert.equal(isMarketOverviewAsk("what's going on"), true);
  assert.equal(isMarketOverviewAsk("What's happening in the market right now?"), true);
  assert.equal(isMarketOverviewAsk("market overview"), true);
  assert.equal(isMarketOverviewAsk("Lead with SPY/QQQ/IWM"), true);
});

test("isMarketOverviewAsk ignores portfolio and single-name asks", () => {
  assert.equal(isMarketOverviewAsk("what's going on with AAPL"), false);
  assert.equal(isMarketOverviewAsk("What's going on with my portfolio"), false);
  assert.equal(isMarketOverviewAsk("Look at my book and hedges"), false);
  assert.equal(isMarketOverviewAsk(""), false);
});

test("tapeFlowSql pins volume to the liquid sleeve", () => {
  const sql = tapeFlowSql("2026-09-04");
  assert.match(sql, /as_of_date = '2026-09-04'/);
  assert.match(sql, /symbol IN \('SPY', 'QQQ'/);
  assert.match(sql, /'XLK'/);
  assert.match(sql, /'IBIT'/);
  assert.doesNotMatch(sql, /EWY|VEU|VGSH|RSP|SIVR|CYTK/);
  assert.ok(TAPE_FLOW_SYMBOLS.includes("SPY"));
  assert.ok(!TAPE_FLOW_SYMBOLS.includes("EWY"));
});

test("tapeFlowSql rejects a non-ISO as_of_date", () => {
  assert.throws(() => tapeFlowSql("yesterday"), /invalid as_of_date/);
});

test("parseTapeFlowRows drops names outside the sleeve", () => {
  const rows = parseTapeFlowRows([
    { symbol: "EWY", type: "call", vol: 9_999_999, oi: 1, iv: 0.4 },
    { symbol: "VEU", type: "put", vol: 8_000_000, oi: 1, iv: 0.3 },
    { symbol: "SPY", type: "call", vol: 1_200_000, oi: 4_000_000, iv: 0.16 },
    { symbol: "spy", type: "PUT", vol: 900_000, oi: 3_000_000, iv: 0.17 },
    { symbol: "SPY", type: "future", vol: 50, oi: 1 },
  ]);
  assert.deepEqual(rows.map((row) => `${row.symbol}:${row.type}`), ["SPY:call", "SPY:put"]);
  assert.equal(rows[0]?.vol, 1_200_000);
});

test("formatMarketTapeSummary tells the model the sleeve is the tape", () => {
  const tape: MarketTape = {
    indexes: [{ ticker: "SPY", name: "S&P 500", spot: 650.12, change_1d_pct: 0.41 }],
    sectors: [
      { ticker: "XLK", name: "Technology", spot: 220, change_1d_pct: 1.2 },
      { ticker: "XLE", name: "Energy", spot: 90, change_1d_pct: -0.8 },
    ],
    flow_as_of_date: "2026-09-04",
    flow_distinct_symbols: 6,
    flow_complete: false,
    flow: [{ symbol: "SPY", type: "call", vol: 1200, oi: 4000, iv: 0.16 }],
    errors: [],
  };
  const text = formatMarketTapeSummary(tape);
  assert.match(text, /liquid sleeve/i);
  assert.match(text, /incomplete ingest/);
  assert.match(text, /Do not invent flow leaders from an unfiltered option_contracts GROUP BY/);
  assert.match(text, /SPY call/);
  assert.doesNotMatch(text, /EWY|VEU/);
  assert.ok(6 < FLOW_COVERAGE_MIN_SYMBOLS);
});

test("loadMarketTape queries indexes, sectors, coverage, then sleeve flow", async () => {
  const sqls: string[] = [];
  const tape = await loadMarketTape(async (sql) => {
    sqls.push(sql);
    if (sql.includes("COUNT(DISTINCT symbol)")) {
      return [{ as_of_date: "2026-09-04", n: 6 }];
    }
    if (sql.includes("SUM(volume)")) {
      return [
        { symbol: "SPY", type: "call", vol: 100, oi: 200, iv: 0.15 },
        { symbol: "EWY", type: "call", vol: 999, oi: 1, iv: 0.4 },
      ];
    }
    if (sql.includes("'SPY'")) {
      return [{ symbol: "SPY", spot: 650, prev_close: 648, date: "2026-09-04" }];
    }
    return [];
  }, Date.parse("2026-09-05T16:00:00Z"));

  assert.equal(sqls.length, 4);
  assert.ok(sqls.some((sql) => sql.includes("'^VIX'")));
  assert.ok(sqls.some((sql) => sql.includes("'XLK'")));
  assert.ok(sqls.some((sql) => sql === tapeCoverageSql()));
  assert.ok(sqls.some((sql) => sql === tapeFlowSql("2026-09-04")));
  assert.equal(tape.flow_as_of_date, "2026-09-04");
  assert.equal(tape.flow_complete, false);
  assert.deepEqual(tape.flow.map((row) => row.symbol), ["SPY"]);
  assert.equal(tape.indexes.find((row) => row.ticker === "SPY")?.spot, 650);
});
