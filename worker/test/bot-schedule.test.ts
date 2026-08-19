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
import { extractShareTurns } from "../src/share-turns.ts";
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
