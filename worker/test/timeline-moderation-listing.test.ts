import assert from "node:assert/strict";
import test from "node:test";
import {
  heuristicTimelineQuality,
  moderateTimelineShare,
} from "../src/timeline-moderation.ts";

/**
 * Mirrors createShare / mintBotShare listing decision: only stamp bot_handle
 * (or insert timeline_posts) when the quality gate allows.
 */
function timelineListingDecision(messages: unknown): {
  on_timeline: boolean;
  moderation_rejected: boolean;
  reason?: string;
} {
  const decision = heuristicTimelineQuality(messages);
  if (decision && !decision.allow) {
    return { on_timeline: false, moderation_rejected: true, reason: decision.reason };
  }
  return { on_timeline: true, moderation_rejected: false };
}

test("bot listing decision rejects the production cut-off share shape", () => {
  const messages = [
    { role: "user", content: "Analyze AAPL options and suggest trades" },
    {
      role: "assistant",
      content: "(see reasoning)",
      sql: "SELECT 1",
      reasoning: "Let me query option_contracts then build a collar... wait,",
    },
  ];
  assert.deepEqual(timelineListingDecision(messages), {
    on_timeline: false,
    moderation_rejected: true,
    reason: "assistant left only a reasoning placeholder — no finished answer",
  });
});

test("bot listing decision allows a finished conclusive answer", () => {
  const messages = [
    { role: "user", content: "Which sector leads OI?" },
    { role: "assistant", content: "Technology leads open interest today, with healthcare second." },
  ];
  assert.deepEqual(timelineListingDecision(messages), {
    on_timeline: true,
    moderation_rejected: false,
  });
});

test("moderateTimelineShare without a model still rejects placeholders", async () => {
  const decision = await moderateTimelineShare(
    [
      { role: "user", content: "AAPL" },
      { role: "assistant", content: "(see reasoning)", reasoning: "still thinking wait," },
    ],
    null,
  );
  assert.equal(decision.allow, false);
  assert.equal(decision.source, "heuristic");
});
