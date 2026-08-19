import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_RUN_TIMEOUT_ERROR,
  BOT_RUN_TIMEOUT_MS,
  botRunExpiryCutoff,
  botShareReuseDecision,
  botSystemAddon,
  expireStuckBotRuns,
  isBotRunTimedOut,
  validateBotInput,
  type BotRun,
} from "../src/bots.ts";
import {
  isBotPromptUsed,
  normalizeBotPrompt,
  pickUnusedSeedPrompt,
  resolveBotGeneratePrompt,
} from "../src/bot-prompt.ts";

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

test("validateBotInput accepts nowlobster market-commentary profile", () => {
  const result = validateBotInput(
    {
      handle: "nowlobster",
      display_name: "Now Lobster",
      persona: "What's happening now",
      bio: "Live desk commentary on the session.",
      system_prompt_extra:
        "You write present-tense market commentary for what is happening right now.",
      seed_prompts: [
        "What's happening in the market right now? Lead with the index move, then the unusual options flow and single-name catalysts that explain it.",
        "Give me live market commentary for this session — SPX/QQQ posture, sector leadership, and the options tape that matters.",
      ],
      enabled: true,
    },
    { requireHandle: true },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.handle, "nowlobster");
  assert.equal(result.value.persona, "What's happening now");
  assert.equal(result.value.seed_prompts.length, 2);
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
  assert.match(text, /render_chart/);
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

function sampleRun(patch: Partial<BotRun> = {}): BotRun {
  return {
    run_id: "run-1",
    handle: "yololobster",
    chat_id: "chat-1",
    share_id: null,
    prompt: "Find lottery tickets",
    status: "running",
    error: null,
    created_at: 1,
    updated_at: 1,
    ...patch,
  };
}

test("botShareReuseDecision creates when the run has no share yet", () => {
  assert.deepEqual(botShareReuseDecision(sampleRun()), {
    action: "create",
    run_id: "run-1",
    handle: "yololobster",
  });
});

test("botShareReuseDecision reuses an existing share_id (idempotent)", () => {
  assert.deepEqual(botShareReuseDecision(sampleRun({ share_id: "AbcShare123", status: "shared" })), {
    action: "reuse",
    share_id: "AbcShare123",
    handle: "yololobster",
  });
});

test("botShareReuseDecision rejects a missing run", () => {
  assert.deepEqual(botShareReuseDecision(null), { action: "not_found" });
  assert.deepEqual(botShareReuseDecision(sampleRun({ share_id: "   " })), {
    action: "create",
    run_id: "run-1",
    handle: "yololobster",
  });
});

test("normalizeBotPrompt collapses case and whitespace", () => {
  assert.equal(normalizeBotPrompt("  Find  LOTTERY   tickets  "), "find lottery tickets");
});

test("isBotPromptUsed matches normalized duplicates", () => {
  assert.equal(isBotPromptUsed("Find lottery tickets", ["  find   LOTTERY tickets "]), true);
  assert.equal(isBotPromptUsed("Find put hedges", ["Find lottery tickets"]), false);
});

test("pickUnusedSeedPrompt skips prompts already used in chats", () => {
  const seeds = [
    "Find lottery-ticket calls with real flow.",
    "Scan for crowded short squeezes with call OI.",
    "Hunt 0DTE call lotteries into catalysts.",
  ];
  assert.equal(
    pickUnusedSeedPrompt(seeds, ["Find lottery-ticket calls with real flow."]),
    "Scan for crowded short squeezes with call OI.",
  );
  assert.equal(
    pickUnusedSeedPrompt(seeds, [
      "Find lottery-ticket calls with real flow.",
      "Scan for crowded short squeezes with call OI.",
      "Hunt 0DTE call lotteries into catalysts.",
    ]),
    null,
  );
});

test("resolveBotGeneratePrompt prefers unused requested, then unused seed, else invent", () => {
  const seeds = ["Seed A", "Seed B"];
  assert.deepEqual(
    resolveBotGeneratePrompt("Brand new angle on IV crush", seeds, ["Seed A"]),
    { prompt: "Brand new angle on IV crush", source: "requested" },
  );
  assert.deepEqual(
    resolveBotGeneratePrompt("Seed A", seeds, ["Seed A"]),
    { prompt: "Seed B", source: "seed" },
  );
  assert.deepEqual(
    resolveBotGeneratePrompt(undefined, seeds, ["Seed A", "Seed B"]),
    { prompt: null, source: "invent" },
  );
  assert.deepEqual(
    resolveBotGeneratePrompt("", seeds, []),
    { prompt: "Seed A", source: "seed" },
  );
});
