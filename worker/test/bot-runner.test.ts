import assert from "node:assert/strict";
import test from "node:test";
import { capShareMessages } from "../src/bot-runner.ts";

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
