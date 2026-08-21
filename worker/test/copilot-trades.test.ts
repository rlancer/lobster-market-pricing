import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTradeLeg,
  formatTradesToolSummary,
  isEquityLeg,
  isOptionLeg,
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
        { instrument: "option", right: "call", side: "buy", strike: 200, expiration: "2026-09-18", dte: 30 },
        { instrument: "option", right: "call", side: "sell", strike: 210, expiration: "2026-09-18", dte: 30 },
      ],
      rationale: "Holding above the 50d with two-sided near-ATM quotes",
      liquidity: "spread ~6%, OI 1.2k",
    }],
  });
  assert.ok(payload);
  assert.equal(payload.trades.length, 1);
  assert.equal(payload.trades[0]!.ticker, "AAPL");
  assert.equal(payload.trades[0]!.legs?.length, 2);
  assert.equal(payload.trades[0]!.legs![0]!.instrument, "option");
  assert.match(formatTradesToolSummary(payload), /AAPL · Bullish \(medium\)/);
});

test("normalizeSuggestedTrades infers option instrument for legacy legs", () => {
  const payload = normalizeSuggestedTrades({
    trades: [{
      ticker: "SPY",
      bias: "bullish",
      conviction: "high",
      structure: "long call",
      legs: [{ right: "call", side: "buy", strike: 500, expiration: "2026-09-18" }],
      rationale: "Breakout continuation",
    }],
  });
  assert.ok(payload);
  const leg = payload.trades[0]!.legs![0]!;
  assert.equal(leg.instrument, "option");
  assert.ok(isOptionLeg(leg));
  assert.equal(leg.right, "call");
});

test("normalizeSuggestedTrades accepts long and short equity legs", () => {
  const payload = normalizeSuggestedTrades({
    trades: [
      {
        ticker: "QQQ",
        bias: "bullish",
        conviction: "medium",
        structure: "long shares",
        legs: [{ instrument: "equity", side: "buy", qty: 100 }],
        rationale: "Trend intact above the 50d",
      },
      {
        ticker: "IWM",
        bias: "bearish",
        conviction: "low",
        structure: "short shares",
        legs: [{ instrument: "equity", side: "sell", qty: 50 }],
        rationale: "Soft breadth in small caps",
      },
    ],
  });
  assert.ok(payload);
  assert.equal(payload.trades.length, 2);
  const longLeg = payload.trades[0]!.legs![0]!;
  const shortLeg = payload.trades[1]!.legs![0]!;
  assert.ok(isEquityLeg(longLeg));
  assert.ok(isEquityLeg(shortLeg));
  assert.equal(longLeg.side, "buy");
  assert.equal(longLeg.qty, 100);
  assert.equal(shortLeg.side, "sell");
  assert.equal(formatTradeLeg(longLeg), "buy 100 shares");
  assert.equal(formatTradeLeg(shortLeg), "sell 50 shares");
});

test("normalizeSuggestedTrades accepts covered call (equity + short call)", () => {
  const payload = normalizeSuggestedTrades({
    trades: [{
      ticker: "AAPL",
      bias: "neutral",
      conviction: "medium",
      structure: "covered call",
      legs: [
        { instrument: "equity", side: "buy", qty: 100 },
        {
          instrument: "option",
          right: "call",
          side: "sell",
          strike: 220,
          expiration: "2026-09-18",
          dte: 30,
          qty: 1,
        },
      ],
      rationale: "Own the stock, sell upside for income",
      liquidity: "OTM call two-sided",
    }],
  });
  assert.ok(payload);
  assert.equal(payload.trades[0]!.legs?.length, 2);
  assert.equal(payload.trades[0]!.legs![0]!.instrument, "equity");
  assert.equal(payload.trades[0]!.legs![1]!.instrument, "option");
  assert.equal(
    formatTradeLeg(payload.trades[0]!.legs![1]!),
    "sell 1 220 call · 2026-09-18 (30d)",
  );
});

test("normalizeSuggestedTrades accepts iron condor (4 option legs)", () => {
  const exp = "2026-09-18";
  const payload = normalizeSuggestedTrades({
    trades: [{
      ticker: "SPY",
      bias: "neutral",
      conviction: "medium",
      structure: "iron condor",
      legs: [
        { instrument: "option", right: "put", side: "buy", strike: 480, expiration: exp, dte: 30, qty: 1 },
        { instrument: "option", right: "put", side: "sell", strike: 490, expiration: exp, dte: 30, qty: 1 },
        { instrument: "option", right: "call", side: "sell", strike: 520, expiration: exp, dte: 30, qty: 1 },
        { instrument: "option", right: "call", side: "buy", strike: 530, expiration: exp, dte: 30, qty: 1 },
      ],
      rationale: "Range-bound into FOMC with two-sided wing quotes",
      liquidity: "wings ~8% wide, OI > 2k",
    }],
  });
  assert.ok(payload);
  assert.equal(payload.trades[0]!.legs?.length, 4);
  assert.ok(payload.trades[0]!.legs!.every((leg) => leg.instrument === "option"));
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

test("normalizeSuggestedTrades defaults skip_reason when trades is empty", () => {
  // Regression: share 1KJpGTK37GDr9SlDCaJxd3aa — model sent trades:[] without
  // skip_reason; rejecting it forced suggest_trades in a loop until the turn died.
  const payload = normalizeSuggestedTrades({ trades: [] });
  assert.ok(payload);
  assert.deepEqual(payload.trades, []);
  assert.match(payload.skip_reason ?? "", /No tradable lean/);
});

test("normalizeSuggestedTrades rejects missing trades array", () => {
  assert.equal(normalizeSuggestedTrades({}), null);
});

test("normalizeSuggestedTrades treats all-invalid trades as empty lean", () => {
  const payload = normalizeSuggestedTrades({
    trades: [{ ticker: "X", bias: "bullish", conviction: "high", structure: "", rationale: "x" }],
  });
  assert.ok(payload);
  assert.deepEqual(payload.trades, []);
  assert.match(payload.skip_reason ?? "", /No tradable lean/);
});

test("normalizeSuggestedTrades drops option legs missing strike and strike_rel", () => {
  const payload = normalizeSuggestedTrades({
    trades: [{
      ticker: "SPY",
      bias: "neutral",
      conviction: "low",
      structure: "iron condor",
      legs: [{ instrument: "option", right: "call", side: "sell" }],
      rationale: "Range-bound tape",
    }],
  });
  assert.ok(payload);
  assert.equal(payload.trades[0]!.legs, undefined);
});

test("normalizeSuggestedTrades drops equity legs missing side", () => {
  const payload = normalizeSuggestedTrades({
    trades: [{
      ticker: "SPY",
      bias: "bullish",
      conviction: "low",
      structure: "long shares",
      legs: [{ instrument: "equity" }],
      rationale: "Beta bid",
    }],
  });
  assert.ok(payload);
  assert.equal(payload.trades[0]!.legs, undefined);
});

test("tradesSuggestBlock requires suggest_trades after desk and documents equity", () => {
  const block = tradesSuggestBlock();
  assert.match(block, /suggest_trades/);
  assert.match(block, /skip_reason/);
  assert.match(block, /option_contracts/);
  assert.match(block, /instrument/);
  assert.match(block, /equity/);
});
