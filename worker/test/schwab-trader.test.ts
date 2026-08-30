import assert from "node:assert/strict";
import test from "node:test";
import {
  dayBoundsIso,
  etMidnightUtc,
  etTradeDay,
  formatOccOptionSymbol,
  inferTradeSide,
  matchesTicker,
  normalizeTrade,
  opaqueAccountId,
  parseTradeDateRange,
  commissionPnl,
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

test("dayBoundsIso covers full America/New_York calendar days", () => {
  // 2026-01-01/02 are EST (UTC−5).
  assert.deepEqual(dayBoundsIso("2026-01-01", "2026-01-02"), {
    startIso: "2026-01-01T05:00:00.000Z",
    endIso: "2026-01-03T04:59:59.999Z",
  });
  // 2026-08-01 is EDT (UTC−4).
  assert.equal(etMidnightUtc("2026-08-01").toISOString(), "2026-08-01T04:00:00.000Z");
  assert.deepEqual(dayBoundsIso("2026-08-01", "2026-08-01"), {
    startIso: "2026-08-01T04:00:00.000Z",
    endIso: "2026-08-02T03:59:59.999Z",
  });
});

test("etTradeDay buckets after-hours ISO timestamps onto the ET calendar", () => {
  assert.equal(etTradeDay("2026-08-28"), "2026-08-28");
  // 5:30pm ET Aug 28 (still same UTC date).
  assert.equal(etTradeDay("2026-08-28T21:30:00.000Z"), "2026-08-28");
  // 9:30pm ET Aug 28 is already Aug 29 UTC.
  assert.equal(etTradeDay("2026-08-29T01:30:00.000Z"), "2026-08-28");
  // Schwab midnight-ET-as-UTC (`+0000`).
  assert.equal(etTradeDay("2026-05-08T04:00:00+0000"), "2026-05-08");
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
  assert.equal(trade.cusip, null);
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

test("normalizeTrade builds an OCC option symbol when Schwab omits symbol", () => {
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
  assert.equal(trade.symbol, "SPY   260918P00500000");
  assert.equal(trade.side, "sell");
  assert.equal(trade.asset_type, "OPTION");
});

test("formatOccOptionSymbol pads root and strike millis", () => {
  assert.equal(
    formatOccOptionSymbol({
      underlying: "CAR",
      expiration: "2026-06-18",
      right: "PUT",
      strike: 390,
    }),
    "CAR   260618P00390000",
  );
  assert.equal(
    formatOccOptionSymbol({
      underlying: "AAPL",
      expiration: "260119",
      right: "C",
      strike: 150.5,
    }),
    "AAPL  260119C00150500",
  );
  assert.equal(
    formatOccOptionSymbol({
      underlying: "SPY",
      expiration: "",
      right: "P",
      strike: 500,
    }),
    null,
  );
});

test("matchesTicker unifies equity and options on the same root", () => {
  assert.equal(matchesTicker({ symbol: "CAR", underlying: null }, "car"), true);
  assert.equal(matchesTicker({ symbol: "CAR   260618P00390000", underlying: "CAR" }, "CAR"), true);
  assert.equal(matchesTicker({ symbol: "CAR 2026-06-18 P 390", underlying: null }, "CAR"), true);
  assert.equal(matchesTicker({ symbol: "CAR260618C00020000", underlying: null }, "CAR"), true);
  assert.equal(matchesTicker({ symbol: "CARD", underlying: null }, "CAR"), false);
  assert.equal(matchesTicker({ symbol: "AAPL", underlying: null }, "CAR"), false);
  assert.equal(matchesTicker({ symbol: "CAR", underlying: null }, null), true);
});

test("commissionPnl treats charged (positive) Schwab fees as a drag", () => {
  assert.equal(commissionPnl(0.32), -0.32);
  assert.equal(commissionPnl(-1), -1);
  assert.equal(commissionPnl(0), 0);
  assert.equal(commissionPnl(null), 0);
});

test("normalizeTrade coerces live positive COMMISSION amounts to P&L", () => {
  const trade = normalizeTrade({
    activityId: 1,
    description: "SOLD 100 CAR",
    type: "TRADE",
    status: "VALID",
    tradeDate: "2026-05-08T15:14:53.000Z",
    netAmount: 14513.68,
    activityType: "EXECUTION",
    transferItems: [
      {
        instrument: { assetType: "EQUITY", symbol: "CAR" },
        amount: -100,
        cost: 14514,
        price: 145.14,
        positionEffect: "CLOSING",
      },
      { amount: 0.32, feeType: "COMMISSION" },
    ],
  });
  assert.equal(trade.fees, -0.32);
});

test("normalizeTrade copies instrument description and CUSIP when tx description is empty", () => {
  const trade = normalizeTrade({
    activityId: 8,
    description: "",
    type: "TRADE",
    status: "VALID",
    tradeDate: "2026-03-18T15:00:00.000Z",
    netAmount: -8726,
    activityType: "EXECUTION",
    transferItems: [
      {
        instrument: {
          assetType: "COLLECTIVE_INVESTMENT",
          symbol: "TLT",
          cusip: "464287432",
          description: "ISHARES 20+ YEAR TREASURY BOND ETF",
        },
        amount: 100,
        cost: -8726,
        price: 87.26,
        positionEffect: "OPENING",
      },
    ],
  });
  assert.equal(trade.symbol, "TLT");
  assert.equal(trade.description, "ISHARES 20+ YEAR TREASURY BOND ETF");
  assert.equal(trade.cusip, "464287432");
});
