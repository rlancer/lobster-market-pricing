import assert from "node:assert/strict";
import test from "node:test";
import {
  legSignedValue,
  parseTrackBody,
  quoteMid,
  structureNetValue,
  suggestionKey,
  unrealizedPnl,
} from "../src/paper-portfolio.ts";
import type { SuggestedTrade } from "../src/copilot-trades.ts";

test("quoteMid prefers two-sided bid/ask", () => {
  assert.equal(quoteMid(1, 3, 9), 2);
  assert.equal(quoteMid(0, 3, 9), 9); // bid must be > 0
  assert.equal(quoteMid(1, 0.5, 9), 9); // ask < bid → last
  assert.equal(quoteMid(null, null, 4.5), 4.5);
  assert.equal(quoteMid(null, null, null), null);
});

test("legSignedValue applies option multiplier and side", () => {
  assert.equal(legSignedValue("option", "buy", 1, 2.5), 250);
  assert.equal(legSignedValue("option", "sell", 2, 1), -200);
  assert.equal(legSignedValue("equity", "buy", 10, 50), 500);
  assert.equal(legSignedValue("equity", "sell", 10, 50), -500);
  assert.equal(legSignedValue("option", "buy", 1, null), null);
});

test("structureNetValue scales by package qty and rejects incomplete", () => {
  assert.equal(structureNetValue([250, -100], 2), 300);
  assert.equal(structureNetValue([250, null], 1), null);
});

test("unrealizedPnl is mark − entry", () => {
  assert.equal(unrealizedPnl(500, 700), 200);
  assert.equal(unrealizedPnl(-300, -100), 200);
  assert.equal(unrealizedPnl(100, null), null);
});

const sampleTrade: SuggestedTrade = {
  ticker: "AAPL",
  bias: "bullish",
  conviction: "high",
  structure: "bull call debit spread",
  rationale: "Momentum into earnings.",
  legs: [
    { instrument: "option", side: "buy", right: "call", strike: 200, expiration: "2026-09-18", dte: 30 },
    { instrument: "option", side: "sell", right: "call", strike: 210, expiration: "2026-09-18", dte: 30 },
  ],
};

test("suggestionKey is stable for the same idea", () => {
  const a = suggestionKey("chat-1", 0, sampleTrade);
  const b = suggestionKey("chat-1", 0, sampleTrade);
  assert.equal(a, b);
  assert.match(a, /^sug_[0-9a-f]{8}$/);
  const other = suggestionKey("chat-1", 1, sampleTrade);
  assert.notEqual(a, other);
});

test("parseTrackBody accepts a suggested trade payload", () => {
  const parsed = parseTrackBody({
    trade: sampleTrade,
    chat_id: "chat-abc",
    trade_index: 0,
    qty: 2,
  });
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.trade.ticker, "AAPL");
  assert.equal(parsed.chat_id, "chat-abc");
  assert.equal(parsed.qty, 2);
  assert.equal(parsed.trade.legs?.length, 2);
});

test("parseTrackBody rejects junk", () => {
  assert.deepEqual(parseTrackBody(null), { error: "invalid JSON body" });
  assert.deepEqual(parseTrackBody({}), { error: "trade is required" });
  assert.deepEqual(parseTrackBody({ trade: { ticker: "X" } }), { error: "invalid trade" });
});

test("autoTrackSuggestedTrades skips empty and missing owner", async () => {
  const { autoTrackSuggestedTrades } = await import("../src/paper-portfolio.ts");

  const emptyDb = {
    prepare() {
      return {
        bind() { return this; },
        async first() { return null; },
        async run() { return {}; },
        async all() { return { results: [] }; },
      };
    },
    async batch() { return []; },
  } as unknown as D1Database;

  const lake = async () => [];

  const empty = await autoTrackSuggestedTrades(emptyDb, lake, "chat-1", { trades: [] });
  assert.equal(empty.skipped, "empty");

  const noOwner = await autoTrackSuggestedTrades(emptyDb, lake, "chat-1", {
    trades: [sampleTrade],
  });
  assert.equal(noOwner.skipped, "no_owner");
});

test("formatPaperPortfolioSummary lists cash and positions", async () => {
  const { formatPaperPortfolioSummary } = await import("../src/paper-portfolio.ts");
  const text = formatPaperPortfolioSummary({
    account: {
      cash: 99_000,
      starting_cash: 100_000,
      equity: 100_250,
      open_pnl: 250,
      realized_pnl: 0,
      created_at: 1,
      updated_at: 1,
    },
    positions: [{
      id: "pos_1",
      status: "open",
      source: "suggestion",
      chat_id: "chat-1",
      suggestion_key: "sug_abc",
      ticker: "AAPL",
      bias: "bullish",
      conviction: "high",
      structure: "bull call debit spread",
      rationale: "Momentum",
      liquidity: null,
      legs: sampleTrade.legs!,
      qty: 1,
      entry_value: 150,
      entry_marked_at: 1,
      mark_value: 400,
      marked_at: 2,
      unrealized_pnl: 250,
      realized_pnl: null,
      opened_at: 1,
      opened_at_iso: "2026-01-01T00:00:00.000Z",
      closed_at: null,
      closed_at_iso: null,
    }],
  });
  assert.match(text, /Paper portfolio/);
  assert.match(text, /AAPL/);
  assert.match(text, /Open PnL/);
  assert.match(text, /bull call debit spread/);
});
