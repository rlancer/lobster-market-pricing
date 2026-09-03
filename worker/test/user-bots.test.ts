import assert from "node:assert/strict";
import test from "node:test";
import { systemPrompt } from "../src/copilot-prompt.ts";
import {
  accountBotPublishDecision,
  resolveUserBotPreset,
  userBotSystemAddon,
  validateUserBotInput,
} from "../src/user-bots.ts";
import {
  assistantExcerptFromTurns,
  buildUserBotAlertEmail,
  clipAlertExcerpt,
} from "../src/user-bot-email.ts";
import { formatSchwabPortfolioSummary } from "../src/schwab-portfolio.ts";

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
  assert.match(result.value.prompt, /get_schwab_portfolio/);
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
    attach_portfolio: true,
    publish_to_timeline: false,
  });
  assert.match(body, /Private account bot/);
  assert.match(body, /get_paper_portfolio/);
  assert.match(body, /get_schwab_portfolio/);
  assert.doesNotMatch(body, /generating a public post/);
  assert.doesNotMatch(body, /MUST still call publish_desk/);
});

test("systemPrompt uses the private addon instead of public bot timeline rules", () => {
  const body = systemPrompt("[schema]", {
    handle: "acct-demo",
    display_name: "Portfolio risk",
    persona: "Private account briefing",
    system_prompt_extra: "",
    audience: "private",
    attach_portfolio: true,
    publish_to_timeline: false,
  });
  assert.match(body, /Private account bot/);
  assert.match(body, /get_schwab_portfolio/);
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

test("alert email prefers the chat link and clips the briefing", () => {
  const excerpt = clipAlertExcerpt("x".repeat(900));
  assert.ok(excerpt.endsWith("…"));
  assert.ok(excerpt.length <= 800);
  const built = buildUserBotAlertEmail({
    botName: "Portfolio risk",
    excerpt: assistantExcerptFromTurns([
      { role: "user", content: "Review my book." },
      { role: "assistant", content: "Trim the NVDA calls before Friday." },
    ]),
    chatUrl: "https://lobster.mp/chat/abc",
  });
  assert.equal(built.subject, "Portfolio risk finished a run");
  assert.match(built.text, /Trim the NVDA calls/);
  assert.match(built.text, /https:\/\/lobster\.mp\/chat\/abc/);
  assert.match(built.html, /Open the briefing/);
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
  assert.doesNotMatch(summary, /12345678/);
});
