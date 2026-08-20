import assert from "node:assert/strict";
import test from "node:test";
import {
  marketHoursEnabled,
  marketState,
  nextScheduleWakeMs,
} from "../src/market-hours.ts";
import {
  scheduleRunDecision,
  validateBotScheduleInput,
} from "../src/bot-schedule.ts";
import { extractShareTurns, applyCaptureToShareTurns } from "../src/share-turns.ts";
import type { UIMessage } from "ai";

test("marketHoursEnabled defaults on unless explicitly false", () => {
  assert.equal(marketHoursEnabled(undefined), true);
  assert.equal(marketHoursEnabled({}), true);
  assert.equal(marketHoursEnabled({ MARKET_HOURS_ENABLED: "false" }), false);
});

test("marketState is closed on a known weekend", () => {
  // Sunday 2026-08-16 15:00 UTC ≈ late morning ET
  const sunday = Date.parse("2026-08-16T15:00:00Z");
  const st = marketState(sunday);
  assert.equal(st.open, false);
  assert.equal(st.reason, "weekend");
  assert.ok(st.next_open && st.next_open > sunday);
});

test("marketState is open mid-session on a weekday", () => {
  // Wednesday 2026-08-19 15:00 UTC = 11:00 EDT
  const wed = Date.parse("2026-08-19T15:00:00Z");
  const st = marketState(wed);
  assert.equal(st.open, true);
  assert.equal(st.reason, "open");
});

test("nextScheduleWakeMs sleeps until after next open when closed", () => {
  const sunday = Date.parse("2026-08-16T15:00:00Z");
  const next = nextScheduleWakeMs(sunday, 3600, { marketGated: true });
  assert.ok(next > sunday);
  const st = marketState(next);
  // Wake is open + up to 30m — still on a trading day after open
  assert.ok(st.open || st.reason === "open" || next > sunday);
});

test("nextScheduleWakeMs adds cadence while open", () => {
  const wed = Date.parse("2026-08-19T15:00:00Z");
  assert.equal(nextScheduleWakeMs(wed, 3600, { marketGated: true }), wed + 3600_000);
});

test("validateBotScheduleInput accepts hourly overview shape", () => {
  const result = validateBotScheduleInput({
    enabled: true,
    cadence_seconds: 3600,
    market_gated: true,
    prompt: "Hourly market overview: what's happening right now?",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.cadence_seconds, 3600);
  assert.equal(result.value.market_gated, true);
});

test("validateBotScheduleInput rejects short cadence", () => {
  assert.equal(
    validateBotScheduleInput({ cadence_seconds: 60, prompt: "x" }).ok,
    false,
  );
});

test("scheduleRunDecision defers when market closed", () => {
  const sunday = Date.parse("2026-08-16T15:00:00Z");
  const decision = scheduleRunDecision(
    {
      handle: "nowlobster",
      enabled: true,
      cadence_seconds: 3600,
      market_gated: true,
      prompt: "overview",
      next_run_at: 0,
      last_run_at: null,
      last_run_id: null,
      consecutive_failures: 0,
      last_error: null,
      created_at: 0,
      updated_at: 0,
    },
    sunday,
  );
  assert.equal(decision.action, "defer");
  if (decision.action !== "defer") return;
  assert.equal(decision.reason, "weekend");
  assert.ok(decision.next_run_at > sunday);
});

test("scheduleRunDecision runs when open and due", () => {
  const wed = Date.parse("2026-08-19T15:00:00Z");
  const decision = scheduleRunDecision(
    {
      handle: "nowlobster",
      enabled: true,
      cadence_seconds: 3600,
      market_gated: true,
      prompt: "overview",
      next_run_at: 0,
      last_run_at: null,
      last_run_id: null,
      consecutive_failures: 0,
      last_error: null,
      created_at: 0,
      updated_at: 0,
    },
    wed,
  );
  assert.equal(decision.action, "run");
});

test("extractShareTurns keeps user and assistant text", () => {
  const messages = [
    {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "What's happening now?" }],
    },
    {
      id: "2",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "checking tape" },
        { type: "text", text: "SPX bid, flow in QQQ calls." },
      ],
      metadata: { createdAt: 1_700_000_000_000 },
    },
  ] as UIMessage[];
  const turns = extractShareTurns(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[1].content, "SPX bid, flow in QQQ calls.");
  assert.equal(turns[1].reasoning, "checking tape");
  assert.equal(turns[1].ts, 1_700_000_000_000);
});

test("extractShareTurns keeps render_chart specs for timeline shares", () => {
  const messages = [
    {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "Chart SPY closes for the last week." }],
    },
    {
      id: "2",
      role: "assistant",
      parts: [
        {
          type: "tool-run_query",
          toolCallId: "q1",
          state: "output-available",
          input: { sql: "SELECT date, close FROM options.ohlc WHERE symbol = 'SPY' LIMIT 7" },
          output: {
            ok: true,
            sql: "SELECT date, close FROM options.ohlc WHERE symbol = 'SPY' LIMIT 7",
            result: {
              columns: ["date", "close"],
              rows: [
                { date: "2026-08-18", close: 640 },
                { date: "2026-08-19", close: 642 },
              ],
            },
          },
        },
        {
          type: "tool-render_chart",
          toolCallId: "c1",
          state: "output-available",
          input: { kind: "line", x: "date", y: "close" },
          output: {
            ok: true,
            sql: "SELECT date, close FROM options.ohlc WHERE symbol = 'SPY' LIMIT 7",
            result: {
              columns: ["date", "close"],
              rows: [
                { date: "2026-08-18", close: 640 },
                { date: "2026-08-19", close: 642 },
              ],
            },
            chart: { kind: "line", x: "date", y: "close", title: "SPY closes" },
          },
        },
        { type: "text", text: "SPY grinded higher into the close." },
      ],
      metadata: { createdAt: 1_700_000_000_100 },
    },
  ] as UIMessage[];
  const turns = extractShareTurns(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].sql, "SELECT date, close FROM options.ohlc WHERE symbol = 'SPY' LIMIT 7");
  assert.deepEqual(turns[1].chart, { kind: "line", x: "date", y: "close", title: "SPY closes" });
});

test("extractShareTurns reads render_chart input when tool output was stripped", () => {
  const messages = [
    {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "Chart SPY closes." }],
    },
    {
      id: "2",
      role: "assistant",
      parts: [
        {
          type: "tool-render_chart",
          toolCallId: "c1",
          state: "input-available",
          input: { kind: "line", x: "date", y: "close", title: "SPY closes" },
        },
        { type: "text", text: "Chart is up." },
      ],
    },
  ] as UIMessage[];
  const turns = extractShareTurns(messages);
  assert.deepEqual(turns[1].chart, { kind: "line", x: "date", y: "close", title: "SPY closes" });
});

test("applyCaptureToShareTurns stamps chart and sql from the turn budget", () => {
  const turns = applyCaptureToShareTurns(
    [
      { role: "user", content: "Chart SPY closes." },
      { role: "assistant", content: "Here you go.", sql: "SELECT 1" },
    ],
    {
      sql: "SELECT date, close FROM options.ohlc WHERE symbol='SPY' LIMIT 10",
      chart: { kind: "line", x: "date", y: "close", title: "SPY closes" },
      result: {
        columns: ["date", "close"],
        rows: [{ date: "2026-08-19", close: 768 }],
      },
    },
    "Chart SPY closes.",
  );
  assert.equal(turns[1].sql, "SELECT date, close FROM options.ohlc WHERE symbol='SPY' LIMIT 10");
  assert.deepEqual(turns[1].chart, { kind: "line", x: "date", y: "close", title: "SPY closes" });
});

test("extractShareTurns infers a chart when the prompt asked and the model skipped render_chart", () => {
  const messages = [
    {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "Plot the NVDA IV smile." }],
    },
    {
      id: "2",
      role: "assistant",
      parts: [
        {
          type: "tool-run_query",
          toolCallId: "q1",
          state: "output-available",
          input: {},
          output: {
            ok: true,
            sql: "SELECT strike, implied_vol, type FROM options.option_contracts LIMIT 20",
            result: {
              columns: ["strike", "implied_vol", "type"],
              rows: [
                { strike: 100, implied_vol: 0.4, type: "call" },
                { strike: 105, implied_vol: 0.38, type: "put" },
              ],
            },
          },
        },
        { type: "text", text: "Smile is bid on the puts." },
      ],
    },
  ] as UIMessage[];
  const turns = extractShareTurns(messages);
  assert.equal(turns[1].chart?.x, "strike");
  assert.equal(turns[1].chart?.y, "implied_vol");
  assert.equal(turns[1].chart?.series, "type");
});

test("extractShareTurns keeps publish_desk viewpoints", () => {
  const messages = [
    {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "What is the desk take on AAPL?" }],
    },
    {
      id: "2",
      role: "assistant",
      parts: [
        {
          type: "tool-publish_desk",
          toolCallId: "d1",
          state: "output-available",
          input: {
            fundamental: "Services mix still expanding",
            technical: "Range-bound above the 50d",
            options: "Near-ATM calls have two-sided quotes",
            overview: "Mildly constructive with defined-risk upside",
          },
          output: {
            ok: true,
            desk: {
              fundamental: "Services mix still expanding",
              technical: "Range-bound above the 50d",
              options: "Near-ATM calls have two-sided quotes",
              overview: "Mildly constructive with defined-risk upside",
            },
          },
        },
        { type: "text", text: "Mildly constructive with defined-risk upside" },
      ],
    },
  ] as UIMessage[];
  const turns = extractShareTurns(messages);
  assert.equal(turns[1].desk?.fundamental, "Services mix still expanding");
  assert.equal(turns[1].desk?.technical, "Range-bound above the 50d");
  assert.equal(turns[1].desk?.options, "Near-ATM calls have two-sided quotes");
  assert.equal(turns[1].desk?.overview, "Mildly constructive with defined-risk upside");
});
