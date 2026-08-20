import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTradesToolSummary,
  normalizeSuggestedTrades,
  tradesSuggestBlock,
} from "../src/copilot-trades.ts";

test("normalizeSuggestedTrades accepts a concrete multi-leg idea", () => {
  const payload = normalizeSuggestedTrades({
    trades: [{
      ticker: "aapl",
      bias: "bullish",
      conviction: "medium",
      structure: "bull call debit spread",
      legs: [
        { right: "call", side: "buy", strike: 200, expiration: "2026-09-18", dte: 30 },
        { right: "call", side: "sell", strike: 210, expiration: "2026-09-18", dte: 30 },
      ],
      rationale: "Holding above the 50d with two-sided near-ATM quotes",
      liquidity: "spread ~6%, OI 1.2k",
    }],
  });
  assert.ok(payload);
  assert.equal(payload.trades.length, 1);
  assert.equal(payload.trades[0]!.ticker, "AAPL");
  assert.equal(payload.trades[0]!.legs?.length, 2);
  assert.match(formatTradesToolSummary(payload), /AAPL · Bullish \(medium\)/);
});

test("normalizeSuggestedTrades allows empty trades with skip_reason", () => {
  const payload = normalizeSuggestedTrades({
    trades: [],
    skip_reason: "One-sided book — no tradable lean",
  });
  assert.deepEqual(payload, {
    trades: [],
    skip_reason: "One-sided book — no tradable lean",
  });
});

test("normalizeSuggestedTrades rejects empty trades without skip_reason", () => {
  assert.equal(normalizeSuggestedTrades({ trades: [] }), null);
  assert.equal(normalizeSuggestedTrades({
    trades: [{ ticker: "X", bias: "bullish", conviction: "high", structure: "", rationale: "x" }],
  }), null);
});

test("normalizeSuggestedTrades drops legs missing strike and strike_rel", () => {
  const payload = normalizeSuggestedTrades({
    trades: [{
      ticker: "SPY",
      bias: "neutral",
      conviction: "low",
      structure: "iron condor",
      legs: [{ right: "call", side: "sell" }],
      rationale: "Range-bound tape",
    }],
  });
  assert.ok(payload);
  assert.equal(payload.trades[0]!.legs, undefined);
});

test("tradesSuggestBlock requires suggest_trades after desk", () => {
  const block = tradesSuggestBlock();
  assert.match(block, /suggest_trades/);
  assert.match(block, /skip_reason/);
  assert.match(block, /option_contracts/);
});
