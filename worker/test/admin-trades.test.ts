import assert from "node:assert/strict";
import test from "node:test";
import {
  clampTradeListLimit,
  flattenEventTrades,
  tradesFromToolArgs,
} from "../src/admin-trades.ts";

test("clampTradeListLimit defaults and caps", () => {
  assert.equal(clampTradeListLimit(undefined), 100);
  assert.equal(clampTradeListLimit(-1), 100);
  assert.equal(clampTradeListLimit(0), 100);
  assert.equal(clampTradeListLimit(50), 50);
  assert.equal(clampTradeListLimit(9999), 500);
  assert.equal(clampTradeListLimit("25"), 25);
});

test("tradesFromToolArgs extracts valid trades and skips junk", () => {
  const trades = tradesFromToolArgs({
    trades: [
      {
        ticker: "AAPL",
        bias: "bullish",
        conviction: "high",
        structure: "bull call debit spread",
        rationale: "Strong momentum into earnings.",
        legs: [{ instrument: "option", right: "call", side: "buy", strike: 200, expiration: "2026-09-18", dte: 30 }],
      },
    ],
  });
  assert.equal(trades.length, 1);
  assert.equal(trades[0]!.ticker, "AAPL");
  assert.equal(trades[0]!.bias, "bullish");

  assert.deepEqual(tradesFromToolArgs({ trades: [] }), []);
  assert.deepEqual(tradesFromToolArgs({ _truncated: true, preview: "…" }), []);
  assert.deepEqual(tradesFromToolArgs(null), []);
  assert.deepEqual(tradesFromToolArgs({ trades: [{ ticker: "X" }] }), []);
});

test("flattenEventTrades builds admin rows with share hints", () => {
  const rows = flattenEventTrades({
    event_id: "ev-1",
    chat_id: "chat-1",
    model: "test/model",
    created_at: 1_700_000_000_000,
    share_id: "share-abc",
    bot_handle: "nowlobster",
    args: {
      trades: [
        {
          ticker: "SPY",
          bias: "neutral",
          conviction: "medium",
          structure: "iron condor",
          rationale: "Range-bound into FOMC.",
          liquidity: "tight book",
        },
        {
          ticker: "QQQ",
          bias: "bearish",
          conviction: "low",
          structure: "put debit spread",
          rationale: "Soft tech breadth.",
        },
      ],
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.id, "ev-1:0");
  assert.equal(rows[0]!.share_id, "share-abc");
  assert.equal(rows[0]!.bot_handle, "nowlobster");
  assert.equal(rows[0]!.ticker, "SPY");
  assert.equal(rows[0]!.liquidity, "tight book");
  assert.equal(rows[0]!.created_at_iso, "2023-11-14T22:13:20.000Z");
  assert.equal(rows[1]!.id, "ev-1:1");
  assert.equal(rows[1]!.ticker, "QQQ");
  assert.equal(rows[1]!.legs, null);
});

test("flattenEventTrades returns empty for no-lean events", () => {
  const rows = flattenEventTrades({
    event_id: "ev-2",
    chat_id: "chat-2",
    model: null,
    created_at: 1_700_000_000_000,
    args: { trades: [], skip_reason: "Thin book" },
  });
  assert.deepEqual(rows, []);
});
