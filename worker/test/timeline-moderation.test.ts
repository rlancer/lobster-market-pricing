import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTimelineModerationTranscript,
  heuristicTimelineQuality,
  lastAssistantView,
  parseTimelineModerationLabel,
  TIMELINE_MODERATION_SYSTEM,
  TIMELINE_QUALITY_REJECTED_ERROR,
} from "../src/timeline-moderation.ts";

test("timeline quality rejected error is the stable client contract", () => {
  assert.match(TIMELINE_QUALITY_REJECTED_ERROR, /public timeline/i);
});

test("moderation system rejects cut-off and placeholder dumps", () => {
  assert.match(TIMELINE_MODERATION_SYSTEM, /cut off/i);
  assert.match(TIMELINE_MODERATION_SYSTEM, /\(see reasoning\)/);
  assert.match(TIMELINE_MODERATION_SYSTEM, /ALLOW or REJECT/);
});

test("parseTimelineModerationLabel accepts exact and padded labels", () => {
  assert.equal(parseTimelineModerationLabel("ALLOW"), true);
  assert.equal(parseTimelineModerationLabel("REJECT"), false);
  assert.equal(parseTimelineModerationLabel(" allow\n"), true);
  assert.equal(parseTimelineModerationLabel("REJECT."), false);
  assert.equal(parseTimelineModerationLabel("Label: REJECT"), false);
  assert.equal(parseTimelineModerationLabel("maybe"), null);
  assert.equal(parseTimelineModerationLabel(""), null);
});

test("lastAssistantView prefers the newest assistant turn with payload", () => {
  assert.equal(lastAssistantView([]), null);
  const view = lastAssistantView([
    { role: "user", content: "AAPL?" },
    { role: "assistant", content: "early" },
    {
      role: "assistant",
      content: "(see reasoning)",
      reasoning: "mid thought wait,",
      desk: { overview: "Mild bullish on AAPL near 317." },
    },
  ]);
  assert.equal(view?.content, "(see reasoning)");
  assert.equal(view?.hasDesk, true);
  assert.equal(view?.deskOverview, "Mild bullish on AAPL near 317.");
});

test("heuristic rejects the cut-off (see reasoning) share pattern", () => {
  const decision = heuristicTimelineQuality([
    {
      role: "user",
      content: "Analyze AAPL with research_ticker and liquid options.",
    },
    {
      role: "assistant",
      content: "(see reasoning)",
      reasoning:
        "Trade 1: Long AAPL shares. Trade 2: Protective put collar: legs option buy put 315 exp 2026-08-28, strike 315... wait,",
      sql: "SELECT 1",
    },
  ]);
  assert.equal(decision?.allow, false);
  assert.equal(decision?.source, "heuristic");
  assert.match(decision?.reason ?? "", /placeholder|cut off|reasoning/i);
});

test("heuristic rejects unfinished tool-loop narration without desk", () => {
  const body = [
    "I have solid two-sided quotes. Let me get the put chain below spot to define a put debit",
    "spread and then reconsider the covered call structure against the ATM calls",
  ].join(" ");
  const decision = heuristicTimelineQuality([
    { role: "user", content: "QQQ ideas" },
    { role: "assistant", content: body },
  ]);
  assert.equal(decision?.allow, false);
  assert.match(decision?.reason ?? "", /cut off|tool-loop|narration/i);
});

test("heuristic allows a finished desk overview", () => {
  const decision = heuristicTimelineQuality([
    { role: "user", content: "AAPL desk" },
    {
      role: "assistant",
      content: "Mild-bullish: ride shares or a 310/320 bull call into the weekly.",
      desk: {
        fundamental: "Megacap quality with declining short interest and steady demand.",
        technical: "SMA20 above SMA50; spot holding above 315 support.",
        options: "Tight two-sided quotes around 315–320 into the next weekly.",
        overview: "Mild-bullish: ride shares or a 310/320 bull call into the weekly.",
      },
      trades: {
        trades: [
          {
            ticker: "AAPL",
            bias: "bullish",
            conviction: "medium",
            structure: "long shares",
            rationale: "Uptrend with liquid chain.",
          },
        ],
      },
    },
  ]);
  assert.equal(decision, null);
});

test("heuristic allows a short conclusive answer without desk chrome", () => {
  const decision = heuristicTimelineQuality([
    { role: "user", content: "What leads OI?" },
    { role: "assistant", content: "Technology leads open interest today." },
  ]);
  assert.equal(decision, null);
});

test("formatTimelineModerationTranscript appends desk context", () => {
  const text = formatTimelineModerationTranscript([
    { role: "user", content: "AAPL?" },
    {
      role: "assistant",
      content: "Takeaway.",
      desk: { overview: "Bullish AAPL near 317 with liquid weeklies." },
      trades: { trades: [{ ticker: "AAPL" }] },
    },
  ]);
  assert.match(text, /user: AAPL\?/);
  assert.match(text, /desk_overview: Bullish AAPL/);
  assert.match(text, /trades: present/);
});
