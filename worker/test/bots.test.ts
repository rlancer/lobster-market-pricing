import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_RUN_TIMEOUT_ERROR,
  BOT_RUN_TIMEOUT_MS,
  botRunExpiryCutoff,
  botSystemAddon,
  expireStuckBotRuns,
  isBotRunTimedOut,
  validateBotInput,
} from "../src/bots.ts";

test("validateBotInput accepts yololobster-style profiles", () => {
  const result = validateBotInput(
    {
      handle: "yololobster",
      display_name: "Yolo Lobster",
      persona: "High risk, high reward",
      system_prompt_extra: "Chase asymmetric upside.",
      seed_prompts: ["Find lottery-ticket calls with real flow."],
      enabled: true,
    },
    { requireHandle: true },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.handle, "yololobster");
  assert.equal(result.value.persona, "High risk, high reward");
  assert.deepEqual(result.value.seed_prompts, ["Find lottery-ticket calls with real flow."]);
});

test("validateBotInput rejects bad handles and empty persona", () => {
  assert.equal(validateBotInput({ handle: "1yolo", display_name: "X", persona: "Y" }, { requireHandle: true }).ok, false);
  assert.equal(validateBotInput({ handle: "ab", display_name: "X", persona: "Y" }, { requireHandle: true }).ok, false);
  assert.equal(validateBotInput({ handle: "yolo-lobster", display_name: "X", persona: "Y" }, { requireHandle: true }).ok, false);
  assert.equal(validateBotInput({ handle: "yololobster", display_name: "X", persona: "  " }, { requireHandle: true }).ok, false);
});

test("botSystemAddon includes handle and persona", () => {
  const text = botSystemAddon({
    handle: "yololobster",
    display_name: "Yolo Lobster",
    persona: "High risk, high reward",
    system_prompt_extra: "Be loud about upside.",
  });
  assert.match(text, /@yololobster/);
  assert.match(text, /High risk, high reward/);
  assert.match(text, /Be loud about upside/);
});

test("BOT_RUN_TIMEOUT_MS is 15 minutes", () => {
  assert.equal(BOT_RUN_TIMEOUT_MS, 15 * 60 * 1000);
});

test("botRunExpiryCutoff subtracts the timeout", () => {
  const now = 1_700_000_000_000;
  assert.equal(botRunExpiryCutoff(now), now - BOT_RUN_TIMEOUT_MS);
});

test("isBotRunTimedOut only flags old queued/running runs", () => {
  const now = 1_700_000_000_000;
  const stale = now - BOT_RUN_TIMEOUT_MS - 1;
  const fresh = now - BOT_RUN_TIMEOUT_MS + 1;
  assert.equal(isBotRunTimedOut("running", stale, now), true);
  assert.equal(isBotRunTimedOut("queued", stale, now), true);
  assert.equal(isBotRunTimedOut("running", fresh, now), false);
  assert.equal(isBotRunTimedOut("queued", fresh, now), false);
  assert.equal(isBotRunTimedOut("shared", stale, now), false);
  assert.equal(isBotRunTimedOut("failed", stale, now), false);
});

type RunRow = {
  run_id: string;
  handle: string;
  chat_id: string;
  share_id: string | null;
  prompt: string;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

/** Minimal in-memory D1 for expireStuckBotRuns UPDATE. */
function botRunsMemoryDb(runs: RunRow[]): D1Database {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          if (sql.includes("WHERE status IN ('queued', 'running')") && sql.includes("created_at <")) {
            const error = String(binds[0]);
            const updatedAt = Number(binds[1]);
            const cutoff = Number(binds[2]);
            let changes = 0;
            for (const run of runs) {
              if ((run.status === "queued" || run.status === "running") && run.created_at < cutoff) {
                run.status = "failed";
                run.error = error;
                run.updated_at = updatedAt;
                changes += 1;
              }
            }
            return { success: true, meta: { changes } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

test("expireStuckBotRuns marks stale queued/running runs failed", async () => {
  const now = 1_700_000_000_000;
  const runs: RunRow[] = [
    {
      run_id: "old-running",
      handle: "yololobster",
      chat_id: "3728227d-c9ef-439f-bd54-f6858f13b152",
      share_id: null,
      prompt: "go",
      status: "running",
      error: null,
      created_at: now - BOT_RUN_TIMEOUT_MS - 60_000,
      updated_at: now - BOT_RUN_TIMEOUT_MS - 60_000,
    },
    {
      run_id: "old-queued",
      handle: "yololobster",
      chat_id: "95e19f18-d94b-4875-af83-18b77f4f06a6",
      share_id: null,
      prompt: "go",
      status: "queued",
      error: null,
      created_at: now - BOT_RUN_TIMEOUT_MS - 1,
      updated_at: now - BOT_RUN_TIMEOUT_MS - 1,
    },
    {
      run_id: "fresh-running",
      handle: "yololobster",
      chat_id: "fresh-chat",
      share_id: null,
      prompt: "go",
      status: "running",
      error: null,
      created_at: now - 60_000,
      updated_at: now - 60_000,
    },
    {
      run_id: "already-shared",
      handle: "yololobster",
      chat_id: "shared-chat",
      share_id: "share-1",
      prompt: "go",
      status: "shared",
      error: null,
      created_at: now - BOT_RUN_TIMEOUT_MS - 120_000,
      updated_at: now - 1_000,
    },
  ];

  const changed = await expireStuckBotRuns(botRunsMemoryDb(runs), now);
  assert.equal(changed, 2);
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].error, BOT_RUN_TIMEOUT_ERROR);
  assert.equal(runs[0].updated_at, now);
  assert.equal(runs[1].status, "failed");
  assert.equal(runs[1].error, BOT_RUN_TIMEOUT_ERROR);
  assert.equal(runs[2].status, "running");
  assert.equal(runs[2].error, null);
  assert.equal(runs[3].status, "shared");
});
