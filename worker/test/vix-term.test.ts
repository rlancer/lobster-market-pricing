import assert from "node:assert/strict";
import test from "node:test";
import {
  computeVixMetrics,
  curveFromQuoteRows,
  curveFromSettleRows,
  daysToExpiry,
  indexesFromOhlcRows,
  loadVixTerm,
  parseMonthlySettleRows,
  resolveVixAsOf,
  settlementDatesFromRows,
  spreadPct,
  vixIndexSql,
  vxQuotesSql,
  vxSettlementsSql,
  type VixCurvePoint,
  type VixIndexes,
} from "../src/vix-term.ts";
import {
  isMonthlyVxQuote,
  isMonthlyVxSettle,
  isVixPageTicker,
  vxFuturesDisplayName,
  vxMonthLabel,
  vxSettlementToQuote,
} from "../src/vx-symbols.ts";

test("vx month labels and settlement mapping", () => {
  assert.equal(vxMonthLabel("VXU26"), "Sep'26");
  assert.equal(vxFuturesDisplayName("VXU26"), "VX Sep'26");
  assert.equal(vxSettlementToQuote("VX/U6", 2026), "VXU26");
  assert.equal(vxSettlementToQuote("VX/F7", 2026), "VXF27");
  assert.equal(vxSettlementToQuote("VX34/Q6", 2026), null);
  assert.equal(isMonthlyVxQuote("VXU26"), true);
  assert.equal(isMonthlyVxQuote("VIXY"), false);
  assert.equal(isMonthlyVxSettle("VX/U6"), true);
  assert.equal(isMonthlyVxSettle("VX34/Q6"), false);
});

test("isVixPageTicker covers cash VIX and monthly VX, not ETPs", () => {
  assert.equal(isVixPageTicker("^VIX"), true);
  assert.equal(isVixPageTicker("vix"), true);
  assert.equal(isVixPageTicker("^VIX3M"), true);
  assert.equal(isVixPageTicker("VVIX"), true);
  assert.equal(isVixPageTicker("VXU26"), true);
  assert.equal(isVixPageTicker("VIXY"), false);
  assert.equal(isVixPageTicker("UVXY"), false);
  assert.equal(isVixPageTicker("SPY"), false);
});

test("resolveVixAsOf rejects future and junk dates", () => {
  assert.equal(resolveVixAsOf(undefined, "2026-09-07"), "2026-09-07");
  assert.equal(resolveVixAsOf("2026-09-04", "2026-09-07"), "2026-09-04");
  assert.equal(resolveVixAsOf("2026-09-10", "2026-09-07"), "2026-09-07");
  assert.equal(resolveVixAsOf("yesterday", "2026-09-07"), "2026-09-07");
});

test("SQL builders pin VX monthals and a validated as-of date", () => {
  const quotes = vxQuotesSql("2026-09-07");
  assert.match(quotes, /FROM options\.futures_quotes/);
  assert.match(quotes, /root = 'VX'/);
  assert.match(quotes, /expiration_date >= '2026-09-07'/);
  const settles = vxSettlementsSql("2026-06-09", "2026-09-07");
  assert.match(settles, /FROM options\.futures_settlements/);
  assert.match(settles, /product = 'VX'/);
  assert.match(settles, /as_of_date >= '2026-06-09'/);
  assert.match(settles, /as_of_date <= '2026-09-07'/);
  const idx = vixIndexSql("2026-06-09", "2026-09-07");
  assert.match(idx, /'\^VIX'/);
  assert.match(idx, /'\^VVIX'/);
  assert.throws(() => vxQuotesSql("nope"), /invalid date/);
});

test("daysToExpiry is calendar days between ISO dates", () => {
  assert.equal(daysToExpiry("2026-09-16", "2026-09-07"), 9);
  assert.equal(daysToExpiry(null, "2026-09-07"), null);
});

test("curveFromQuoteRows prepends spot and ranks unexpired monthals", () => {
  const spot = {
    symbol: "^VIX",
    name: "VIX",
    last: 15.2,
    prev: 16.1,
    change_pct: spreadPct(16.1, 15.2),
    date: "2026-09-07",
  };
  const curve = curveFromQuoteRows([
    { contract_symbol: "VX34Q6", last: 99, expiration_date: "2026-08-26", prev_close: 99 },
    { symbol: "VXV26", last: 17.1, prev_close: 17, expiration_date: "2026-10-21" },
    { symbol: "VXU26", last: 16.4, prev_close: 17, expiration_date: "2026-09-16", volume: 120_000, open_interest: 80_000 },
    { symbol: "VXX26", last: 18, prev_close: 18, expiration_date: "2026-11-18" },
  ], "2026-09-07", spot);
  assert.equal(curve[0]?.kind, "spot");
  assert.equal(curve[0]?.last, 15.2);
  assert.equal(curve[1]?.symbol, "VXU26");
  assert.equal(curve[1]?.tenor, 1);
  assert.equal(curve[1]?.label, "Sep'26");
  assert.ok(curve[1]?.change_pct != null && curve[1]!.change_pct! < 0);
  assert.equal(curve[2]?.symbol, "VXV26");
  assert.equal(curve.some((p) => p.symbol === "VX34Q6"), false);
});

test("settlement rows drop weeklies and map VX/U6 onto VXU26", () => {
  const rows = parseMonthlySettleRows([
    { as_of_date: "2026-09-04", contract_symbol: "VX/U6", expiration_date: "2026-09-16", settle_price: 16.5 },
    { as_of_date: "2026-09-04", contract_symbol: "VX34/Q6", expiration_date: "2026-08-26", settle_price: 15 },
    { as_of_date: "2026-09-03", contract_symbol: "VX/U6", expiration_date: "2026-09-16", settle_price: 17 },
  ]);
  assert.deepEqual(rows.map((r) => r.symbol), ["VXU26", "VXU26"]);
  assert.equal(settlementDatesFromRows(rows, "2026-09-07")[0], "2026-09-04");
});

test("curveFromSettleRows uses the prior session's same contract as prev", () => {
  const rows = parseMonthlySettleRows([
    { as_of_date: "2026-09-04", contract_symbol: "VX/U6", expiration_date: "2026-09-16", settle_price: 16.5 },
    { as_of_date: "2026-09-04", contract_symbol: "VX/V6", expiration_date: "2026-10-21", settle_price: 17.2 },
    { as_of_date: "2026-09-03", contract_symbol: "VX/U6", expiration_date: "2026-09-16", settle_price: 17 },
  ]);
  const prev = new Map([["VXU26", 17], ["VXV26", 17]]);
  const spot = {
    symbol: "^VIX", name: "VIX", last: 15, prev: 16, change_pct: spreadPct(16, 15), date: "2026-09-04",
  };
  const curve = curveFromSettleRows(rows, "2026-09-04", spot, prev);
  assert.equal(curve[1]?.symbol, "VXU26");
  assert.equal(curve[1]?.last, 16.5);
  assert.equal(curve[1]?.prev, 17);
  assert.equal(curve[2]?.symbol, "VXV26");
});

test("computeVixMetrics reads M1-M2 and M4-M7 and labels contango", () => {
  const indexes = indexesFromOhlcRows([
    { symbol: "^VIX", date: "2026-09-07", close: 15 },
    { symbol: "^VIX", date: "2026-09-04", close: 16 },
    { symbol: "^VIX3M", date: "2026-09-07", close: 17 },
  ], "2026-09-07");
  const last = (tenor: number, value: number): VixCurvePoint => ({
    tenor,
    kind: tenor === 0 ? "spot" : "future",
    symbol: tenor === 0 ? "^VIX" : `M${tenor}`,
    label: tenor === 0 ? "Spot" : `M${tenor}`,
    last: value,
    prev: value,
    change: 0,
    change_pct: 0,
    expiration: null,
    dte: null,
    volume: null,
    open_interest: null,
    bid: null,
    ask: null,
    settle: value,
  });
  const curve = [last(0, 15), last(1, 16), last(2, 17), last(3, 18), last(4, 19), last(5, 20), last(6, 21), last(7, 22)];
  const metrics = computeVixMetrics(curve, indexes);
  assert.equal(metrics.shape, "contango");
  assert.ok(metrics.m1_m2_pct != null && Math.abs(metrics.m1_m2_pct - (1 / 16) * 100) < 1e-9);
  assert.ok(metrics.m4_m7_pct != null && Math.abs(metrics.m4_m7_pct - (3 / 19) * 100) < 1e-9);
  assert.ok(metrics.vix_vs_m1_pct != null);
});

test("loadVixTerm uses delayed quotes on a live as-of and settlements when asked historically", async () => {
  const lake = async (sql: string): Promise<Record<string, unknown>[]> => {
    if (sql.includes("futures_quotes")) {
      return [
        { contract_symbol: "VXU26", expiration_date: "2026-09-16", last: 16.4, prev_close: 17, volume: 10, open_interest: 20 },
        { contract_symbol: "VXV26", expiration_date: "2026-10-21", last: 17.1, prev_close: 17 },
      ];
    }
    if (sql.includes("futures_settlements")) {
      return [
        { as_of_date: "2026-09-04", contract_symbol: "VX/U6", expiration_date: "2026-09-16", settle_price: 16.8 },
        { as_of_date: "2026-09-04", contract_symbol: "VX/V6", expiration_date: "2026-10-21", settle_price: 17.4 },
        { as_of_date: "2026-09-03", contract_symbol: "VX/U6", expiration_date: "2026-09-16", settle_price: 17.2 },
        { as_of_date: "2026-09-03", contract_symbol: "VX/V6", expiration_date: "2026-10-21", settle_price: 17.5 },
      ];
    }
    return [
      { symbol: "^VIX", date: "2026-09-04", close: 15.1 },
      { symbol: "^VIX", date: "2026-09-03", close: 16.0 },
      { symbol: "^VVIX", date: "2026-09-04", close: 90 },
    ];
  };

  const live = await loadVixTerm({
    queryLake: lake,
    asOfDate: "2026-09-04",
    now: Date.parse("2026-09-04T20:00:00Z"),
  });
  assert.equal(live.source, "quotes");
  assert.equal(live.curve[1]?.symbol, "VXU26");
  assert.equal(live.curve[1]?.last, 16.4);
  assert.equal(live.indexes.vix.last, 15.1);
  assert.ok(live.settlement_dates.includes("2026-09-04"));
  assert.equal(live.history[0]?.date, "2026-09-04");

  const hist = await loadVixTerm({
    queryLake: async (sql) => {
      if (sql.includes("futures_quotes")) assert.fail("historical as-of must not read delayed quotes");
      return lake(sql);
    },
    asOfDate: "2026-09-03",
    now: Date.parse("2026-09-04T20:00:00Z"),
  });
  assert.equal(hist.source, "settlements");
  assert.equal(hist.as_of, "2026-09-03");
  assert.equal(hist.curve[1]?.symbol, "VXU26");
  assert.equal(hist.curve[1]?.last, 17.2);
});

test("loadVixTerm falls back to settlements when quotes are empty", async () => {
  const term = await loadVixTerm({
    queryLake: async (sql) => {
      if (sql.includes("futures_quotes")) return [];
      if (sql.includes("futures_settlements")) {
        return [
          { as_of_date: "2026-09-04", contract_symbol: "VX/U6", expiration_date: "2026-09-16", settle_price: 16.8 },
          { as_of_date: "2026-09-04", contract_symbol: "VX/V6", expiration_date: "2026-10-21", settle_price: 17.4 },
        ];
      }
      return [{ symbol: "^VIX", date: "2026-09-04", close: 15 }];
    },
    asOfDate: "2026-09-04",
    now: Date.parse("2026-09-04T20:00:00Z"),
  });
  assert.equal(term.source, "settlements");
  assert.equal(term.curve[1]?.last, 16.8);
});

test("indexesFromOhlcRows pick the last two sessions at or before as-of", () => {
  const indexes: VixIndexes = indexesFromOhlcRows([
    { symbol: "^VIX", date: "2026-09-07", close: 14 },
    { symbol: "^VIX", date: "2026-09-04", close: 15 },
    { symbol: "^VIX", date: "2026-09-03", close: 16 },
  ], "2026-09-04");
  assert.equal(indexes.vix.last, 15);
  assert.equal(indexes.vix.prev, 16);
  assert.equal(indexes.vix.date, "2026-09-04");
});
