import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRealizedPnlLedger,
  fetchWindowForPnl,
  resolvePnlRange,
  seriesFromLedger,
  SCHWAB_PNL_RANGES,
} from "../src/schwab-pnl.ts";
import type { SchwabTrade } from "../src/schwab-trader.ts";
import { SCHWAB_TRADES_MAX_RANGE_DAYS } from "../src/schwab-trader.ts";

function trade(partial: Partial<SchwabTrade> & Pick<SchwabTrade, "id" | "trade_date" | "side">): SchwabTrade {
  return {
    activity_id: null,
    settlement_date: null,
    description: null,
    status: "VALID",
    activity_type: "EXECUTION",
    net_amount: null,
    symbol: "AAPL",
    underlying: null,
    asset_type: "EQUITY",
    quantity: null,
    price: null,
    cost: null,
    fees: null,
    position_effect: null,
    order_id: null,
    position_id: null,
    ...partial,
  };
}

test("resolvePnlRange accepts presets and defaults to YTD", () => {
  const now = new Date("2026-08-28T16:00:00.000Z"); // afternoon ET still Aug 28
  const ytd = resolvePnlRange(null, now);
  assert.ok(!("error" in ytd));
  if ("error" in ytd) return;
  assert.equal(ytd.range, "YTD");
  assert.equal(ytd.start, "2026-01-01");
  assert.equal(ytd.end, "2026-08-28");

  const mtd = resolvePnlRange("mtd", now);
  assert.ok(!("error" in mtd));
  if ("error" in mtd) return;
  assert.equal(mtd.range, "MTD");
  assert.equal(mtd.start, "2026-08-01");

  const oneY = resolvePnlRange("1Y", now);
  assert.ok(!("error" in oneY));
  if ("error" in oneY) return;
  assert.equal(oneY.range, "1Y");
  // 365 calendar days inclusive → start = end - 364d
  assert.equal(oneY.start, "2025-08-29");

  assert.ok("error" in resolvePnlRange("ALL", now));
  assert.deepEqual(SCHWAB_PNL_RANGES, ["MTD", "YTD", "1M", "3M", "6M", "1Y"]);
});

test("fetchWindowForPnl extends to Schwab max lookback for basis", () => {
  const w = fetchWindowForPnl("2026-08-01", "2026-08-28");
  assert.equal(w.end, "2026-08-28");
  // 365 inclusive days (Schwab-safe), not the full 366 constant.
  const endMs = Date.parse("2026-08-28T00:00:00.000Z");
  const expectedStart = new Date(
    endMs - (365 - 1) * 24 * 60 * 60 * 1000,
  ).toISOString().slice(0, 10);
  assert.equal(w.start, expectedStart);
  assert.ok(expectedStart >= new Date(
    endMs - (SCHWAB_TRADES_MAX_RANGE_DAYS - 1) * 24 * 60 * 60 * 1000,
  ).toISOString().slice(0, 10));
});

test("FIFO long round-trip realizes proceeds − basis", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-01-10T15:00:00.000Z",
      side: "buy",
      quantity: 10,
      net_amount: -1000,
      position_effect: "OPENING",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2026-02-10T15:00:00.000Z",
      side: "sell",
      quantity: 10,
      net_amount: 1150,
      position_effect: "CLOSING",
    }),
  ]);
  assert.equal(ledger.daily.get("2026-02-10"), 150);
  assert.equal(ledger.closingTradeCount, 1);
  assert.equal(ledger.unmatchedCloseCount, 0);

  const { points, summary } = seriesFromLedger(ledger, "2026-01-01", "2026-03-01");
  assert.equal(summary.period_pnl, 150);
  assert.equal(points[0]!.cumulative_pnl, 0);
  assert.equal(points[points.length - 1]!.cumulative_pnl, 150);
});

test("FIFO short cover realizes short proceeds − buyback", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-03-01T15:00:00.000Z",
      side: "sell",
      quantity: 5,
      net_amount: 500,
      position_effect: "OPENING",
      symbol: "MSFT",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2026-03-15T15:00:00.000Z",
      side: "buy",
      quantity: 5,
      net_amount: -450,
      position_effect: "CLOSING",
      symbol: "MSFT",
    }),
  ]);
  assert.equal(ledger.daily.get("2026-03-15"), 50);
});

test("partial FIFO close realizes pro-rata", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-01-05",
      side: "buy",
      quantity: 100,
      net_amount: -10000,
      position_effect: "OPENING",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2026-01-20",
      side: "sell",
      quantity: 40,
      net_amount: 4800,
      position_effect: "CLOSING",
    }),
  ]);
  // basis 40/100 * 10000 = 4000; proceeds 4800 → +800
  assert.equal(ledger.daily.get("2026-01-20"), 800);
});

test("CLOSING without in-window open is unmatched (no phantom PnL)", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-06-01",
      side: "sell",
      quantity: 10,
      net_amount: 2000,
      position_effect: "CLOSING",
    }),
  ]);
  assert.equal(ledger.unmatchedCloseCount, 1);
  assert.equal(ledger.daily.size, 0);
});

test("seriesFromLedger only accumulates chart-window days", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2025-12-01",
      side: "buy",
      quantity: 10,
      net_amount: -1000,
      position_effect: "OPENING",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2025-12-15",
      side: "sell",
      quantity: 10,
      net_amount: 1100,
      position_effect: "CLOSING",
    }),
    trade({
      id: "3",
      activity_id: 3,
      trade_date: "2026-02-01",
      side: "buy",
      quantity: 10,
      net_amount: -500,
      position_effect: "OPENING",
      symbol: "XYZ",
    }),
    trade({
      id: "4",
      activity_id: 4,
      trade_date: "2026-02-10",
      side: "sell",
      quantity: 10,
      net_amount: 700,
      position_effect: "CLOSING",
      symbol: "XYZ",
    }),
  ]);
  // Dec close +200 is outside YTD window; Feb close +200 is inside.
  const { summary, points } = seriesFromLedger(ledger, "2026-01-01", "2026-02-28");
  assert.equal(summary.period_pnl, 200);
  assert.equal(points[points.length - 1]!.cumulative_pnl, 200);
});
