import assert from "node:assert/strict";
import test from "node:test";
import { remoderateListedBotShares } from "../src/timeline.ts";

const JUNK = JSON.stringify([
  { role: "user", content: "Macro / rates desk hourly." },
  {
    role: "assistant",
    content: [
      "Chart: x=date, series=DGS10. Let me chart value with series=series_id.",
      "Let me publish desk. The prompt says active specialists fill ONLY these fields.",
      "Looking at routing examples I think I should include macro. Good.",
    ].join(" "),
    desk: {
      overview: "REPLACE_WITH_NULL_VALUE_BLOCKED_INVALID:",
      fundamental: "REPLACE_WITH_NULL_VALUE_BLOCKED_INVALID:",
      macro: "Let me refresh the curve frame first.",
    },
  },
]);

const GOOD = JSON.stringify([
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
  },
]);

function mockDb(rows: Array<{ share_id: string; messages: string }>) {
  const cleared: string[] = [];
  return {
    cleared,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              if (/FROM shared_chats/.test(sql)) return { results: rows };
              return { results: [] };
            },
            async run() {
              if (/SET bot_handle = NULL/.test(sql)) cleared.push(String(args[0]));
              return { success: true };
            },
          };
        },
      };
    },
  };
}

test("remoderateListedBotShares unlists junk desks and keeps finished ones", async () => {
  const db = mockDb([
    { share_id: "1qKRZL7BSEpll6HDPoypuU8bS", messages: JUNK },
    { share_id: "goodShareFinishedDesk00001", messages: GOOD },
  ]);
  const summary = await remoderateListedBotShares(db as unknown as D1Database, {
    newerThanMs: 0,
    limit: 10,
  });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.unlisted, 1);
  assert.deepEqual(db.cleared, ["1qKRZL7BSEpll6HDPoypuU8bS"]);
});
