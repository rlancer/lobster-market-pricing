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

test("extractTradesFromShareMessages reads assistant trades", async () => {
  const { extractTradesFromShareMessages } = await import("../src/bot-trades.ts");
  const json = JSON.stringify([
    { role: "user", content: "scan" },
    {
      role: "assistant",
      content: "yolo",
      trades: {
        trades: [sampleTrade],
      },
    },
  ]);
  const found = extractTradesFromShareMessages(json);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.trades[0]?.ticker, "NVDA");
  assert.deepEqual(extractTradesFromShareMessages("not-json"), []);
  assert.deepEqual(extractTradesFromShareMessages("[]"), []);
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

test("listBotTrades filters positions and tallies by conviction", async () => {
  const { listBotTrades } = await import("../src/bot-trades.ts");
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  const openHigh = {
    id: "bpos_high",
    bot_handle: "yololobster",
    status: "open",
    chat_id: "c1",
    share_id: null,
    run_id: null,
    suggestion_key: "sug_high",
    ticker: "NVDA",
    bias: "bullish",
    conviction: "high",
    structure: "long call",
    rationale: "x",
    liquidity: null,
    legs_json: "[]",
    qty: 1,
    entry_value: 100,
    entry_marked_at: 1,
    mark_value: 150,
    marked_at: 2,
    realized_pnl: null,
    opened_at: 10,
    closed_at: null,
  };

  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          statements.push({ sql, binds });
          return this;
        },
        async all() {
          const last = statements[statements.length - 1]!;
          if (last.sql.includes("FROM bot_trade_positions") && last.sql.includes("SELECT *")) {
            return { results: [openHigh] };
          }
          return { results: [] };
        },
        async first() {
          const last = statements[statements.length - 1]!;
          if (last.sql.includes("SUM(CASE WHEN status")) {
            assert.ok(last.sql.includes("conviction = ?2"));
            assert.equal(last.binds[1], "high");
            return { open_count: 1, closed_count: 0, realized_pnl: 0 };
          }
          return null;
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
    },
  } as unknown as D1Database;

  const lake = async () => [];
  const book = await listBotTrades(db, lake, "yololobster", {
    status: "open",
    conviction: "high",
    refreshMarks: false,
    backfill: false,
  });
  assert.ok(book);
  assert.equal(book!.positions.length, 1);
  assert.equal(book!.positions[0]?.conviction, "high");
  assert.equal(book!.summary.open_count, 1);
  assert.equal(book!.summary.open_pnl, 50);

  const select = statements.find((s) => s.sql.includes("SELECT *") && s.sql.includes("conviction = ?3"));
  assert.ok(select, "expected status+conviction select");
  assert.deepEqual(select!.binds.slice(0, 3), ["yololobster", "open", "high"]);
});

test("listBotTrades skips lake when marks are fresh", async () => {
  const { listBotTrades } = await import("../src/bot-trades.ts");
  const now = Date.now();
  const openHigh = {
    id: "bpos_high",
    bot_handle: "yololobster",
    status: "open",
    chat_id: "c1",
    share_id: null,
    run_id: null,
    suggestion_key: "sug_high",
    ticker: "NVDA",
    bias: "bullish",
    conviction: "high",
    structure: "long call",
    rationale: "x",
    liquidity: null,
    legs_json: JSON.stringify([
      { instrument: "option", side: "buy", right: "call", strike: 140, expiration: "2026-09-18" },
    ]),
    qty: 1,
    entry_value: 100,
    entry_marked_at: now - 60_000,
    mark_value: 150,
    marked_at: now - 60_000,
    realized_pnl: null,
    opened_at: 10,
    closed_at: null,
  };

  let lakeCalls = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async all() {
          if (sql.includes("SELECT *") && sql.includes("bot_trade_positions")) {
            return { results: [openHigh] };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes("SUM(CASE WHEN status")) {
            return { open_count: 1, closed_count: 0, realized_pnl: 0 };
          }
          return null;
        },
        async run() { return { meta: { changes: 0 } }; },
      };
    },
    async batch() { return []; },
  } as unknown as D1Database;

  const lake = async () => {
    lakeCalls += 1;
    return [];
  };

  const book = await listBotTrades(db, lake, "yololobster", {
    status: "open",
    refreshMarks: true,
  }, now);
  assert.ok(book);
  assert.equal(lakeCalls, 0);
  assert.equal(book!.positions[0]?.mark_value, 150);
});

test("listBotTrades does not backfill by default", async () => {
  const { listBotTrades } = await import("../src/bot-trades.ts");
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind() { return this; },
        async all() { return { results: [] }; },
        async first() {
          if (sql.includes("SUM(CASE WHEN status")) {
            return { open_count: 0, closed_count: 0, realized_pnl: 0 };
          }
          return null;
        },
        async run() { return { meta: { changes: 0 } }; },
      };
    },
    async batch() { return []; },
  } as unknown as D1Database;

  await listBotTrades(db, async () => [], "yololobster", { status: "open" });
  assert.ok(!statements.some((s) => s.includes("shared_chats") || s.includes("copilot_tool_events")));
});
