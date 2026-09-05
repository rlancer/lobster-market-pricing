import assert from "node:assert/strict";
import test from "node:test";
import { botShareFloorDecision, capShareMessages } from "../src/bot-runner.ts";

test("botShareFloorDecision lists a finished scheduled post", () => {
  assert.deepEqual(botShareFloorDecision({ listOnFloor: true, moderationAllow: true }), {
    stampHandle: true,
    runStatus: "shared",
  });
});

test("botShareFloorDecision fails a quality-rejected Floor post", () => {
  assert.deepEqual(botShareFloorDecision({ listOnFloor: true, moderationAllow: false }), {
    stampHandle: false,
    runStatus: "failed",
    failReason: "timeline quality",
  });
});

test("botShareFloorDecision keeps QA runs unlisted and successful", () => {
  assert.deepEqual(botShareFloorDecision({ listOnFloor: false, moderationAllow: true }), {
    stampHandle: false,
    runStatus: "shared",
  });
  assert.deepEqual(botShareFloorDecision({ listOnFloor: false, moderationAllow: false }), {
    stampHandle: false,
    runStatus: "shared",
  });
});

test("capShareMessages keeps structured trades on assistant turns", () => {
  const { messages, title } = capShareMessages(
    [
      { role: "user", content: "Analyze SPY and suggest trades" },
      {
        role: "assistant",
        content: "SPY holds the range with defined-risk ideas.",
        desk: {
          fundamental: "Fund take",
          technical: "Tech take",
          options: "Opts take",
          overview: "SPY holds the range with defined-risk ideas.",
        },
        trades: {
          trades: [
            {
              ticker: "SPY",
              bias: "bullish",
              conviction: "medium",
              structure: "long shares",
              rationale: "Uptrend intact",
              legs: [{ instrument: "equity", side: "buy", qty: 100 }],
            },
            {
              ticker: "SPY",
              bias: "neutral",
              conviction: "medium",
              structure: "iron condor",
              rationale: "Range-bound",
              legs: [
                { instrument: "option", side: "buy", right: "put", strike: 730, expiration: "2026-09-18" },
                { instrument: "option", side: "sell", right: "put", strike: 745, expiration: "2026-09-18" },
                { instrument: "option", side: "sell", right: "call", strike: 780, expiration: "2026-09-18" },
                { instrument: "option", side: "buy", right: "call", strike: 795, expiration: "2026-09-18" },
              ],
            },
          ],
        },
      },
    ],
    "SPY desk",
  );
  assert.equal(title, "SPY desk");
  assert.equal(messages.length, 2);
  const assistant = messages[1]!;
  assert.ok(assistant.desk);
  assert.ok(assistant.trades);
  const trades = assistant.trades as { trades: unknown[] };
  assert.equal(trades.trades.length, 2);
});

test("capShareMessages keeps every SQL query and tool call on bot Floor posts", () => {
  const { messages } = capShareMessages(
    [
      { role: "user", content: "Tape?" },
      {
        role: "assistant",
        content: "SPY holds the range.",
        sql: "SELECT expiration FROM options.option_contracts LIMIT 10",
        queries: [
          "SELECT close FROM options.ohlc WHERE symbol = 'SPY' LIMIT 5",
          "SELECT expiration FROM options.option_contracts LIMIT 10",
        ],
        tools: [
          { name: "run_query", args: "SELECT close FROM options.ohlc", ok: true },
          { name: "check_schema", args: "SELECT expiration", ok: true },
          { name: "run_query", args: "SELECT expiration FROM options.option_contracts", ok: true },
          { name: "get_news", args: "SPY", ok: true },
        ],
        frames: [{ name: "last", columns: ["expiration"], row_count: 10, sql: "SELECT expiration FROM options.option_contracts LIMIT 10", fetched_at: 1 }],
      },
    ],
  );
  const assistant = messages[1]!;
  assert.deepEqual(assistant.queries, [
    "SELECT close FROM options.ohlc WHERE symbol = 'SPY' LIMIT 5",
    "SELECT expiration FROM options.option_contracts LIMIT 10",
  ]);
  assert.equal((assistant.tools as unknown[]).length, 4);
  assert.equal((assistant.frames as unknown[]).length, 1);
});
