import assert from "node:assert/strict";
import test from "node:test";
import {
  dayBoundsIso,
  inferTradeSide,
  normalizeTrade,
  opaqueAccountId,
  parseTradeDateRange,
  toTradeAccounts,
  SCHWAB_TRADES_MAX_RANGE_DAYS,
} from "../src/schwab-trader.ts";

test("opaqueAccountId matches portfolio masking scheme", () => {
  assert.equal(opaqueAccountId(0, "12345678"), "schwab-0-5678");
});

test("toTradeAccounts drops empty hashes and keeps internal hash", () => {
  const rows = toTradeAccounts([
    { accountNumber: "11112222", hashValue: "abc" },
    { accountNumber: "3333", hashValue: "" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.hash, "abc");
  assert.equal(rows[0]!.label, "••••2222");
  assert.equal(rows[0]!.id, "schwab-0-2222");
});

test("parseTradeDateRange defaults to ~90 days and enforces max window", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  const ok = parseTradeDateRange(null, null, now);
  assert.deepEqual(ok, { start: "2026-05-30", end: "2026-08-28" });

  assert.equal(
    ("error" in parseTradeDateRange("2026-01-01", "2025-12-01", now)),
    true,
  );
  const tooLong = parseTradeDateRange("2024-01-01", "2026-01-15", now);
  assert.ok("error" in tooLong);
  assert.match((tooLong as { error: string }).error, new RegExp(String(SCHWAB_TRADES_MAX_RANGE_DAYS)));

  assert.deepEqual(parseTradeDateRange("2026-01-01", "2026-03-01", now), {
    start: "2026-01-01",
    end: "2026-03-01",
  });
});

test("dayBoundsIso covers full UTC days", () => {
  assert.deepEqual(dayBoundsIso("2026-01-01", "2026-01-02"), {
    startIso: "2026-01-01T00:00:00.000Z",
    endIso: "2026-01-02T23:59:59.999Z",
  });
});

test("inferTradeSide prefers description then cost sign", () => {
  assert.equal(inferTradeSide("BOUGHT 10 AAPL @ 145", 10, -1450), "buy");
  assert.equal(inferTradeSide("SOLD 5 MSFT", -5, 2000), "sell");
  assert.equal(inferTradeSide(null, 10, -100), "buy");
  assert.equal(inferTradeSide(null, -10, 100), "sell");
  assert.equal(inferTradeSide(null, null, null), "unknown");
});

test("normalizeTrade extracts equity leg + fees", () => {
  const trade = normalizeTrade({
    activityId: 9876543210,
    description: "BOUGHT 10 AAPL @ 145.32",
    type: "TRADE",
    status: "VALID",
    tradeDate: "2024-03-15T15:30:00.000Z",
    settlementDate: "2024-03-17T00:00:00.000Z",
    netAmount: -1454.2,
    activityType: "EXECUTION",
    orderId: 67890,
    transferItems: [
      {
        instrument: {
          assetType: "EQUITY",
          symbol: "AAPL",
          description: "Apple Inc",
        },
        amount: 10,
        cost: -1453.2,
        price: 145.32,
        positionEffect: "OPENING",
      },
      { amount: -1, feeType: "COMMISSION" },
    ],
  });
  assert.equal(trade.symbol, "AAPL");
  assert.equal(trade.side, "buy");
  assert.equal(trade.quantity, 10);
  assert.equal(trade.price, 145.32);
  assert.equal(trade.fees, -1);
  assert.equal(trade.position_effect, "OPENING");
  assert.equal(trade.id, "9876543210");
});

test("normalizeTrade prefers equity leg over CURRENCY_USD cash leg", () => {
  const trade = normalizeTrade({
    activityId: 42,
    description: "SOLD 50 AAPL @ 200",
    type: "TRADE",
    status: "VALID",
    tradeDate: "2026-06-01T15:00:00.000Z",
    netAmount: 9990,
    activityType: "EXECUTION",
    transferItems: [
      {
        instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" },
        amount: 0,
        cost: 9990,
        price: 0,
      },
      {
        instrument: {
          assetType: "EQUITY",
          symbol: "AAPL",
          description: "Apple Inc",
        },
        amount: -50,
        cost: 10000,
        price: 200,
        positionEffect: "CLOSING",
      },
      { amount: -10, feeType: "COMMISSION" },
    ],
  });
  assert.equal(trade.symbol, "AAPL");
  assert.equal(trade.asset_type, "EQUITY");
  assert.equal(trade.side, "sell");
  assert.equal(trade.quantity, -50);
  assert.equal(trade.position_effect, "CLOSING");
  assert.equal(trade.fees, -10);
});
  const trade = normalizeTrade({
    activityId: 1,
    description: "SOLD 1 SPY PUT",
    transferItems: [
      {
        instrument: {
          assetType: "OPTION",
          underlyingSymbol: "SPY",
          putCall: "PUT",
          strikePrice: 500,
          expirationDate: "2026-09-18T00:00:00.000Z",
        },
        amount: -1,
        cost: 250,
        price: 2.5,
        positionEffect: "OPENING",
      },
    ],
  });
  assert.equal(trade.underlying, "SPY");
  assert.equal(trade.symbol, "SPY 2026-09-18 P 500");
  assert.equal(trade.side, "sell");
  assert.equal(trade.asset_type, "OPTION");
});
