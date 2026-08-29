import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPnlFills,
  buildRealizedPnlLedger,
  fetchWindowForPnl,
  normalizeSchwabDistribution,
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

function daySum(ledger: ReturnType<typeof buildRealizedPnlLedger>, day: string): number {
  return ledger.events.filter((e) => e.day === day).reduce((s, e) => s + e.amount, 0);
}

test("resolvePnlRange accepts presets and defaults to YTD", () => {
  const now = new Date("2026-08-28T16:00:00.000Z");
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
  assert.equal(oneY.start, "2025-08-29");

  assert.ok("error" in resolvePnlRange("ALL", now));
  assert.deepEqual(SCHWAB_PNL_RANGES, ["MTD", "YTD", "1M", "3M", "6M", "1Y"]);
});

test("fetchWindowForPnl extends to Schwab max lookback for basis", () => {
  const w = fetchWindowForPnl("2026-08-01", "2026-08-28");
  assert.equal(w.end, "2026-08-28");
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
  assert.equal(daySum(ledger, "2026-02-10"), 150);
  assert.equal(ledger.closingTradeCount, 1);
  assert.equal(ledger.unmatchedCloseCount, 0);

  const { points, summary } = seriesFromLedger(ledger, "2026-01-01", "2026-03-01");
  assert.equal(summary.period_pnl, 150);
  assert.equal(summary.prior_open_pnl, 0);
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
  assert.equal(daySum(ledger, "2026-03-15"), 50);
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
  assert.equal(daySum(ledger, "2026-01-20"), 800);
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
  assert.equal(ledger.events.length, 0);
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
  const { summary, points } = seriesFromLedger(ledger, "2026-01-01", "2026-02-28");
  assert.equal(summary.period_pnl, 200);
  assert.equal(summary.prior_open_pnl, 0);
  assert.equal(points[points.length - 1]!.cumulative_pnl, 200);
});

test("closes of lots opened before the period are excluded from period_pnl", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-07-15",
      side: "buy",
      quantity: 10,
      net_amount: -1000,
      position_effect: "OPENING",
      symbol: "SVIX",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2026-08-03",
      side: "sell",
      quantity: 10,
      net_amount: 700,
      position_effect: "CLOSING",
      symbol: "SVIX",
    }),
    trade({
      id: "3",
      activity_id: 3,
      trade_date: "2026-08-05",
      side: "buy",
      quantity: 5,
      net_amount: -200,
      position_effect: "OPENING",
      symbol: "LOFD",
    }),
    trade({
      id: "4",
      activity_id: 4,
      trade_date: "2026-08-10",
      side: "sell",
      quantity: 5,
      net_amount: 250,
      position_effect: "CLOSING",
      symbol: "LOFD",
    }),
  ]);
  // SVIX: opened July, closed Aug → −300 prior; LOFD: open+close in Aug → +50 period
  const { summary, points } = seriesFromLedger(ledger, "2026-08-01", "2026-08-31");
  assert.equal(summary.period_pnl, 50);
  assert.equal(summary.prior_open_pnl, -300);
  assert.equal(points[points.length - 1]!.cumulative_pnl, 50);

  const fills = buildPnlFills(ledger, "2026-08-01", "2026-08-31");
  assert.equal(fills.length, 2);
  const lofd = fills.find((f) => f.symbol === "LOFD");
  const svix = fills.find((f) => f.symbol === "SVIX");
  assert.ok(lofd);
  assert.ok(svix);
  assert.equal(lofd!.realized_pnl, 50);
  assert.equal(lofd!.prior_open, false);
  assert.equal(svix!.realized_pnl, -300);
  assert.equal(svix!.prior_open, true);
});

test("normalizeSchwabDistribution sums currency legs", () => {
  const d = normalizeSchwabDistribution({
    activityId: 99,
    time: "2026-03-15T12:00:00.000Z",
    description: "Ordinary Dividend",
    type: "DIVIDEND_OR_INTEREST",
    status: "VALID",
    netAmount: 12.5,
    transferItems: [
      {
        instrument: { assetType: "EQUITY", symbol: "VTI", description: "VANGUARD TOTAL STOCK" },
        amount: 0,
      },
      {
        instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" },
        amount: 12.5,
      },
    ],
  });
  assert.ok(d);
  assert.equal(d!.date, "2026-03-15");
  assert.equal(d!.symbol, "VTI");
  assert.equal(d!.amount, 12.5);
  assert.equal(d!.id, "dist-99");
});

test("buildPnlFills includes fees from the closing trade", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-01-10",
      side: "buy",
      quantity: 10,
      net_amount: -1000,
      fees: 1,
      position_effect: "OPENING",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2026-02-10",
      side: "sell",
      quantity: 10,
      net_amount: 1145,
      fees: 5,
      price: 115,
      position_effect: "CLOSING",
    }),
  ]);
  const fills = buildPnlFills(ledger, "2026-01-01", "2026-03-01");
  assert.equal(fills.length, 1);
  assert.equal(fills[0]!.fees, 5);
  assert.equal(fills[0]!.realized_pnl, 145);
  assert.equal(fills[0]!.quantity, 10);
});
