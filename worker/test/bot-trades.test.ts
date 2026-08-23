import assert from "node:assert/strict";
import test from "node:test";
import type { SuggestedTrade } from "../src/copilot-trades.ts";

const sampleTrade: SuggestedTrade = {
  ticker: "NVDA",
  bias: "bullish",
  conviction: "high",
  structure: "long call",
  rationale: "Momentum into AI spend.",
  legs: [
    { instrument: "option", side: "buy", right: "call", strike: 140, expiration: "2026-09-18", dte: 30 },
  ],
};

test("trackBotSuggestedTrades skips empty and missing handle", async () => {
  const { trackBotSuggestedTrades } = await import("../src/bot-trades.ts");

  const emptyDb = {
    prepare() {
      return {
        bind() { return this; },
        async first() { return null; },
        async run() { return { meta: { changes: 0 } }; },
        async all() { return { results: [] }; },
      };
    },
    async batch() { return []; },
  } as unknown as D1Database;

  const lake = async () => [];

  const empty = await trackBotSuggestedTrades(emptyDb, lake, "yololobster", "chat-1", { trades: [] });
  assert.equal(empty.skipped, "empty");

  const noBot = await trackBotSuggestedTrades(emptyDb, lake, "!!!", "chat-1", {
    trades: [sampleTrade],
  });
  assert.equal(noBot.skipped, "no_bot");
});

test("formatBotTradesSummary lists handle and PnL", async () => {
  const { formatBotTradesSummary } = await import("../src/bot-trades.ts");
  const text = formatBotTradesSummary({
    bot_handle: "yololobster",
    summary: {
      open_count: 1,
      closed_count: 0,
      open_pnl: 250,
      realized_pnl: 0,
    },
    positions: [{
      id: "bpos_1",
      bot_handle: "yololobster",
      status: "open",
      chat_id: "chat-1",
      share_id: "share_abc",
      run_id: "run_1",
      suggestion_key: "sug_abc",
      ticker: "NVDA",
      bias: "bullish",
      conviction: "high",
      structure: "long call",
      rationale: "Momentum",
      liquidity: null,
      legs: sampleTrade.legs!,
      qty: 1,
      entry_value: 400,
      entry_marked_at: 1,
      mark_value: 650,
      marked_at: 2,
      unrealized_pnl: 250,
      realized_pnl: null,
      opened_at: 1,
      opened_at_iso: "2026-01-01T00:00:00.000Z",
      closed_at: null,
      closed_at_iso: null,
    }],
  });
  assert.match(text, /@yololobster/);
  assert.match(text, /NVDA/);
  assert.match(text, /Open PnL/);
  assert.match(text, /long call/);
  assert.match(text, /share_abc/);
});

test("linkBotTradesShare updates rows for a chat", async () => {
  const { linkBotTradesShare } = await import("../src/bot-trades.ts");
  let bound: unknown[] = [];
  const db = {
    prepare() {
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        async run() {
          return { meta: { changes: 2 } };
        },
      };
    },
  } as unknown as D1Database;

  const n = await linkBotTradesShare(db, "chat-xyz", "share-1");
  assert.equal(n, 2);
  assert.deepEqual(bound, ["share-1", "chat-xyz"]);
});
