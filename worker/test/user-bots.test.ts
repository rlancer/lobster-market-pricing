import assert from "node:assert/strict";
import test from "node:test";
import { systemPrompt } from "../src/chat-prompt.ts";
import {
  accountBotPublishDecision,
  attachablePortfolioOptions,
  expireStaleActiveUserBotRun,
  parsePortfolioOptionId,
  resolveUserBotPortfolio,
  resolveUserBotPreset,
  USER_BOT_FORCE_STALE_MS,
  userBotSystemAddon,
  validateUserBotInput,
} from "../src/user-bots.ts";
import { publicChatOrigin } from "../src/user-bot-runner.ts";
import {
  assistantBriefingFromTurns,
  buildUserBotAlertEmail,
  normalizeAlertBriefing,
  sendUserBotAlert,
  USER_BOT_ALERT_FROM,
} from "../src/user-bot-email.ts";
import { filterSchwabPortfolioView, formatSchwabPortfolioSummary } from "../src/schwab-portfolio.ts";

test("hourly_market is the friendly default schedule", () => {
  const preset = resolveUserBotPreset("hourly_market");
  assert.ok(preset);
  assert.equal(preset.cadence_seconds, 3600);
  assert.equal(preset.market_gated, true);
  assert.match(preset.label, /US market hours/);
});

test("validateUserBotInput rejects cron-like empty prompts and fills the default preset", () => {
  assert.equal(validateUserBotInput({ name: "Risk", prompt: "   " }).ok, false);
  const result = validateUserBotInput({
    name: "Risk desk",
    prompt: "Review my book.",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.schedule_preset, "hourly_market");
  assert.equal(result.value.market_gated, true);
  assert.equal(result.value.attach_portfolio, true);
  assert.equal(result.value.portfolio_source, "paper");
  assert.equal(result.value.portfolio_account_id, null);
  assert.deepEqual(result.value.portfolio_ids, ["paper"]);
  assert.equal(result.value.publish_to_timeline, false);
  assert.equal(result.value.email_alerts, true);
});

test("validateUserBotInput applies a template prompt when the body omits prompt", () => {
  const result = validateUserBotInput({
    name: "Adjustments",
    template_id: "adjustments",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.value.prompt, /attached book/);
});

test("validateUserBotInput accepts a specific Schwab account", () => {
  const result = validateUserBotInput({
    name: "Schwab desk",
    prompt: "Review the margin book.",
    portfolio_id: "schwab:acct-1",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.portfolio_source, "schwab");
  assert.equal(result.value.portfolio_account_id, "acct-1");
  assert.deepEqual(result.value.portfolio_ids, ["schwab:acct-1"]);
  assert.equal(result.value.attach_portfolio, true);
});

test("validateUserBotInput accepts several books on portfolio_ids", () => {
  const result = validateUserBotInput({
    name: "Both books",
    prompt: "Review both books.",
    portfolio_ids: ["paper", "schwab:acct-1", "schwab:acct-2"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.portfolio_source, "all");
  assert.deepEqual(result.value.portfolio_ids, ["paper", "schwab:acct-1", "schwab:acct-2"]);
});

test("legacy attach_portfolio false still means no book", () => {
  const none = resolveUserBotPortfolio({ attach_portfolio: false });
  assert.equal(none.source, "none");
  assert.deepEqual(none.ids, []);
  assert.equal(parsePortfolioOptionId("schwab:abc-9")?.accountId, "abc-9");
});

test("attachablePortfolioOptions lists paper, each Schwab account, then combined books", () => {
  const options = attachablePortfolioOptions([
    { id: "a1", label: "Schwab · ••••5678 · MARGIN" },
    { id: "a2", label: "Schwab · ••••1234 · CASH" },
  ]);
  assert.deepEqual(options.map((item) => item.id), [
    "none",
    "paper",
    "schwab:a1",
    "schwab:a2",
    "schwab",
    "all",
  ]);
});

test("private bots stay off the timeline unless the owner opted in and has a handle", () => {
  assert.deepEqual(
    accountBotPublishDecision({ publish_to_timeline: false, hasHandle: true }),
    { action: "keep_private" },
  );
  assert.deepEqual(
    accountBotPublishDecision({ publish_to_timeline: true, hasHandle: false }),
    { action: "keep_private", reason: "claim a public handle to publish" },
  );
  assert.deepEqual(
    accountBotPublishDecision({ publish_to_timeline: true, hasHandle: true }),
    { action: "publish" },
  );
});

test("userBotSystemAddon never asks for a public timeline post by default", () => {
  const body = userBotSystemAddon({
    name: "Portfolio risk",
    portfolio_source: "paper",
    publish_to_timeline: false,
  });
  assert.match(body, /Private account bot/);
  assert.match(body, /get_paper_portfolio/);
  assert.match(body, /lookup_symbols/);
  assert.match(body, /top holdings/);
  assert.doesNotMatch(body, /MUST call get_portfolio with source="schwab"/);
  assert.doesNotMatch(body, /generating a public post/);
  assert.doesNotMatch(body, /MUST still call publish_desk/);
});

test("userBotSystemAddon scopes a Schwab account and skips the paper tool", () => {
  const body = userBotSystemAddon({
    name: "Schwab risk",
    portfolio_source: "schwab",
    portfolio_account_id: "acct-1",
    portfolio_label: "Schwab · ••••5678 · MARGIN",
    publish_to_timeline: false,
  });
  assert.match(body, /Schwab · ••••5678/);
  assert.match(body, /get_portfolio with source="schwab"/);
  assert.match(body, /account_id="acct-1"/);
  assert.doesNotMatch(body, /MUST call get_paper_portfolio/);
});

test("systemPrompt uses the private addon instead of public bot timeline rules", () => {
  const body = systemPrompt("[schema]", {
    handle: "acct-demo",
    display_name: "Portfolio risk",
    persona: "Private account briefing",
    system_prompt_extra: "",
    audience: "private",
    portfolio_source: "all",
    attach_portfolio: true,
    publish_to_timeline: false,
  });
  assert.match(body, /Private account bot/);
  assert.match(body, /get_portfolio with source="schwab"/);
  assert.doesNotMatch(body, /public post for this bot's timeline/);
  assert.doesNotMatch(body, /MUST still call publish_desk/);
});

test("systemPrompt still requires publish_desk on public bot timeline posts", () => {
  const body = systemPrompt("[schema]", {
    handle: "macrolobster",
    display_name: "Macro Lobster",
    persona: "Rates, the curve, and the cycle",
    system_prompt_extra: "Lead with options.yields.",
  });
  assert.match(body, /MUST still call publish_desk/);
});

test("publicChatOrigin points email at the site that can restore the transcript", () => {
  assert.equal(publicChatOrigin("https://api-dev.lobster.mp"), "https://dev.lobster.mp");
  assert.equal(publicChatOrigin("https://api.lobster.mp"), "https://lobster.mp");
  assert.equal(publicChatOrigin(undefined), "https://lobster.mp");
});

test("alert email prefers the chat link and keeps the full briefing", () => {
  const long = "x".repeat(900);
  const briefing = normalizeAlertBriefing(long);
  assert.equal(briefing.length, 900);
  assert.equal(briefing.endsWith("…"), false);
  const built = buildUserBotAlertEmail({
    botName: "Portfolio risk",
    title: "Trim NVDA before Friday",
    briefing: assistantBriefingFromTurns([
      { role: "user", content: "Review my book." },
      { role: "assistant", content: `## Takeaway\n\nTrim the NVDA calls before Friday.\n\n${long}` },
    ]),
    chatUrl: "https://lobster.mp/chat/abc",
  });
  assert.equal(built.subject, "Trim NVDA before Friday");
  assert.match(built.text, /Trim the NVDA calls/);
  assert.match(built.text, new RegExp(long));
  assert.match(built.text, /https:\/\/lobster\.mp\/chat\/abc/);
  assert.match(built.html, /Open the briefing/);
  assert.match(built.html, /Trim the NVDA calls/);
  assert.match(built.html, /<h2[^>]*>Takeaway<\/h2>/);
  assert.doesNotMatch(built.html, /…/);
});

test("alert email falls back to bot-finished subject without a title", () => {
  const built = buildUserBotAlertEmail({
    botName: "Portfolio risk",
    title: "   ",
    briefing: "Ready.",
    chatUrl: "https://lobster.mp/chat/abc",
  });
  assert.equal(built.subject, "Portfolio risk finished a run");
});

test("sendUserBotAlert is from The Lobster with sunglasses and uses the title subject", async () => {
  const sent: unknown[] = [];
  const result = await sendUserBotAlert(
    {
      async send(message) {
        sent.push(message);
        return { messageId: "mid-1" };
      },
    },
    "owner@example.com",
    {
      botName: "Portfolio risk",
      title: "Cut concentration in the book",
      briefing: "Trim the overweight name.",
      chatUrl: "https://lobster.mp/chat/abc",
    },
  );
  assert.deepEqual(result, { ok: true, message_id: "mid-1" });
  assert.equal(sent.length, 1);
  const message = sent[0] as {
    from: { email: string; name: string };
    subject: string;
  };
  assert.deepEqual(message.from, USER_BOT_ALERT_FROM);
  assert.match(message.from.name, /The Lobster/);
  assert.match(message.from.name, /😎/);
  assert.equal(message.subject, "Cut concentration in the book");
});

test("formatSchwabPortfolioSummary keeps masked accounts and skips empty books", () => {
  const summary = formatSchwabPortfolioSummary({
    connected: true,
    fetched_at: "2026-09-02T15:00:00.000Z",
    accounts: [{
      id: "schwab-0-5678",
      account_number_masked: "••••5678",
      type: "MARGIN",
      cash: 1200,
      equity: 50_000,
      buying_power: 10_000,
      day_pnl: -80,
      open_pnl: 250,
      positions: [{
        id: "p1",
        symbol: "AAPL",
        underlying: null,
        description: "APPLE INC",
        asset_type: "EQUITY",
        quantity: 10,
        average_price: 180,
        market_value: 1900,
        day_pnl: -20,
        open_pnl: 100,
        cusip: null,
      }],
    }],
    totals: {
      cash: 1200,
      equity: 50_000,
      buying_power: 10_000,
      day_pnl: -80,
      open_pnl: 250,
      position_count: 1,
      account_count: 1,
    },
  });
  assert.match(summary, /••••5678/);
  assert.match(summary, /AAPL/);
  assert.match(summary, /equity/);
  assert.match(summary, /APPLE INC/);
  assert.doesNotMatch(summary, /12345678/);
});

test("filterSchwabPortfolioView keeps one account and recomputes totals", () => {
  const view = {
    connected: true as const,
    fetched_at: "2026-09-02T15:00:00.000Z",
    accounts: [
      {
        id: "keep",
        account_number_masked: "••••1111",
        type: "MARGIN",
        cash: 100,
        equity: 1_000,
        buying_power: 500,
        day_pnl: 10,
        open_pnl: 20,
        positions: [{
          id: "p1",
          symbol: "AAPL",
          underlying: null,
          description: null,
          asset_type: "EQUITY",
          quantity: 1,
          average_price: 1,
          market_value: 2,
          day_pnl: 0,
          open_pnl: 1,
          cusip: null,
        }],
      },
      {
        id: "drop",
        account_number_masked: "••••9999",
        type: "CASH",
        cash: 9_000,
        equity: 9_000,
        buying_power: 9_000,
        day_pnl: 90,
        open_pnl: 90,
        positions: [],
      },
    ],
    totals: {
      cash: 9_100,
      equity: 10_000,
      buying_power: 9_500,
      day_pnl: 100,
      open_pnl: 110,
      position_count: 1,
      account_count: 2,
    },
  };
  const filtered = filterSchwabPortfolioView(view, "keep");
  assert.equal(filtered.accounts.length, 1);
  assert.equal(filtered.accounts[0]?.id, "keep");
  assert.equal(filtered.totals.cash, 100);
  assert.equal(filtered.totals.account_count, 1);
  assert.equal(filtered.totals.position_count, 1);
  const both = filterSchwabPortfolioView(view, ["keep", "drop"]);
  assert.equal(both.accounts.length, 2);
  assert.equal(both.totals.account_count, 2);
});

test("USER_BOT_FORCE_STALE_MS is two minutes so Run now can replace a hung row", () => {
  assert.equal(USER_BOT_FORCE_STALE_MS, 2 * 60 * 1000);
});

type UserRunRow = {
  run_id: string;
  bot_id: string;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

function userBotRunsMemoryDb(runs: UserRunRow[]): D1Database {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          if (sql.includes("bot_id = ?3") && sql.includes("created_at < ?4")) {
            const error = String(binds[0]);
            const updatedAt = Number(binds[1]);
            const botId = String(binds[2]);
            const cutoff = Number(binds[3]);
            let changes = 0;
            for (const run of runs) {
              if (
                run.bot_id === botId
                && (run.status === "queued" || run.status === "running")
                && run.created_at < cutoff
              ) {
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

test("expireStaleActiveUserBotRun only drops this bot's old in-flight row", async () => {
  const now = 1_700_000_000_000;
  const runs: UserRunRow[] = [
    {
      run_id: "stale",
      bot_id: "bot-a",
      status: "running",
      error: null,
      created_at: now - USER_BOT_FORCE_STALE_MS - 1,
      updated_at: now - USER_BOT_FORCE_STALE_MS - 1,
    },
    {
      run_id: "fresh",
      bot_id: "bot-a",
      status: "running",
      error: null,
      created_at: now - 1_000,
      updated_at: now - 1_000,
    },
    {
      run_id: "other",
      bot_id: "bot-b",
      status: "running",
      error: null,
      created_at: now - USER_BOT_FORCE_STALE_MS - 1,
      updated_at: now - USER_BOT_FORCE_STALE_MS - 1,
    },
  ];
  const changes = await expireStaleActiveUserBotRun(
    userBotRunsMemoryDb(runs),
    "bot-a",
    USER_BOT_FORCE_STALE_MS,
    now,
  );
  assert.equal(changes, 1);
  assert.equal(runs[0]?.status, "failed");
  assert.equal(runs[0]?.error, "stale run replaced by Run now");
  assert.equal(runs[1]?.status, "running");
  assert.equal(runs[2]?.status, "running");
});
