import assert from "node:assert/strict";
import test from "node:test";
import {
  heuristicTimelineQuality,
  lastAssistantView,
  moderateTimelineShare,
  parseTimelineModerationLabel,
  TIMELINE_MODERATION_SYSTEM,
  TIMELINE_QUALITY_REJECTED_ERROR,
  PRIVATE_BRIEFING_MODERATION_SYSTEM,
} from "../src/timeline-moderation.ts";
import { coalesceAssistantMessageRecords } from "../src/share-turns.ts";

test("timeline quality rejected error is the stable client contract", () => {
  assert.match(TIMELINE_QUALITY_REJECTED_ERROR, /the Floor/i);
});

test("moderation system rejects cut-off and placeholder dumps", () => {
  assert.match(TIMELINE_MODERATION_SYSTEM, /cut off/i);
  assert.match(TIMELINE_MODERATION_SYSTEM, /\(see reasoning\)/);
  assert.match(TIMELINE_MODERATION_SYSTEM, /ALLOW or REJECT/);
});

test("private briefing moderator does not require Floor desk chrome", () => {
  assert.match(PRIVATE_BRIEFING_MODERATION_SYSTEM, /private account-bot/);
  assert.match(PRIVATE_BRIEFING_MODERATION_SYSTEM, /Do not require publish_desk/);
  assert.match(PRIVATE_BRIEFING_MODERATION_SYSTEM, /no macro specialist active/);
  assert.match(PRIVATE_BRIEFING_MODERATION_SYSTEM, /ALLOW or REJECT/);
  assert.doesNotMatch(PRIVATE_BRIEFING_MODERATION_SYSTEM, /PUBLIC Floor/);
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
      desk: {
        overview: "Mild bullish on AAPL near 317 with a defined-risk call.",
        options: "Near-ATM calls still quote two-sided into the next weekly.",
      },
    },
  ]);
  assert.equal(view?.content, "(see reasoning)");
  assert.equal(view?.hasDesk, true);
  assert.equal(view?.deskOverview, "Mild bullish on AAPL near 317 with a defined-risk call.");
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

test("heuristic rejects leaked DSML tool markup without a takeaway", () => {
  const content = [
    "The chart and data are ready. Now I need to publish the desk view. Let me also render a second chart.",
    "",
    "<｜DSML｜tool_calls>",
    "<｜DSML｜invoke name=\"render_chart\">",
    "<｜DSML｜parameter name=\"y\" string=\"true\">close</｜DSML｜parameter>",
    "</｜DSML｜invoke>",
    "</｜DSML｜tool_calls>",
  ].join("\n");
  const decision = heuristicTimelineQuality([
    { role: "user", content: "Hourly market overview" },
    { role: "assistant", content, chart: { kind: "line", x: "date", y: "close" } },
  ]);
  assert.equal(decision?.allow, false);
  assert.match(decision?.reason ?? "", /tool-call markup|takeaway/i);
});

test("heuristic rejects protocol-echo desk plus planning-only body", () => {
  // Regression: share wnJWqaRxtCu1I3CLJIgCiaon — garbage desk sealed the Floor.
  const decision = heuristicTimelineQuality([
    {
      role: "user",
      content: "Hourly market overview: what's happening right now? Lead with SPX/QQQ/IWM.",
    },
    {
      role: "assistant",
      content:
        "Since this is a broad market overview ask, I should charter the index series and check a few sector ETFs for leadership. Let me grab sector ETF closes (XLK tech, XLF financials) for the recent week, plus maybe EWY to explain the flow.",
      desk: {
        overview: "Received: ... first include Text 'Received'",
        fundamental: "Received: ... first include Text & 'Received'",
        technical: "Received: ... first include Text Received",
        options: "Received: ... first include the Text Received",
        risk: "Received: ... first include Text Received",
        macro: "Received: ... first include Text 'Received'",
      },
    },
  ]);
  assert.equal(decision?.allow, false);
  assert.equal(decision?.source, "heuristic");
  assert.match(decision?.reason ?? "", /placeholder|tool-loop|narration|empty/i);
});

test("heuristic rejects null-token desk plus tool-loop body (share 1qKRZL7)", () => {
  // Regression: macrolobster share 1qKRZL7BSEpll6HDPoypuU8bS — rejected
  // publish_desk leftover (REPLACE_WITH_NULL…) counted as a sealed desk, so
  // period-ending scratchpad listed on the Floor.
  const decision = heuristicTimelineQuality([
    {
      role: "user",
      content:
        "Macro / rates desk hourly: pull options.yields for the Treasury curve (DGS2/DGS10/DGS30).",
    },
    {
      role: "assistant",
      content: [
        "Chart: x=date, series=DGS10 (or multiple series). render_chart series param — probably series=series_id?",
        "Actually for multi-series need to specify. Let me chart value with series=series_id, x=date, y=value.",
        "Let me publish desk (fundamental not relevant here — this is macro desk; active: Technical, Options, Risk, Macro).",
        "The prompt says active specialists fill ONLY these: Fundamental, Technical, Options, Risk, Macro.",
        "Looking at routing examples: broad beta / rates ETFs or Fed/CPI asks → include macro.",
        "I think I should keep it relevant — I can give Fundamental a thin-but-real take on the inflation cycle. Good.",
      ].join(" "),
      desk: {
        overview: "REPLACE_WITH_NULL_VALUE_BLOCKED_INVALID:",
        fundamental: "REPLACE_WITH_NULL_VALUE_BLOCKED_INVALID:",
        macro:
          "The frame 'last' was overwritten by fed_odds. I need to specify the frame in render_chart. Let me refresh the curve frame first.",
      },
    },
  ]);
  assert.equal(decision?.allow, false);
  assert.equal(decision?.source, "heuristic");
  assert.match(decision?.reason ?? "", /tool-loop|narration|placeholder|empty/i);
});

test("heuristic rejects reasoning promoted into suggest_trades scratch (share 1qKRZL7 heal)", () => {
  // coalesce lifts a reasoning paragraph; that lift must still fail the gate.
  const decision = heuristicTimelineQuality([
    { role: "user", content: "Macro / rates desk hourly." },
    {
      role: "assistant",
      content: [
        "Also suggest_trades — this is a macro timeline post with a tradable lean.",
        "I could offer a Kalshi KXFED-26SEP-T3.75 contract (yes/no) as the binary play.",
        "Actually I can suggest a Kalshi trade: buy NO on KXFED-26SEP-T3.75.",
        "That is tradable with real two-sided quotes. Good.",
      ].join(" "),
    },
  ]);
  assert.equal(decision?.allow, false);
  assert.match(decision?.reason ?? "", /tool-loop|narration|empty/i);
});

test("lastAssistantView does not treat a null-token desk as sealed", () => {
  const view = lastAssistantView([
    {
      role: "assistant",
      content: "Let me re-run the curve query first, then render_chart.",
      desk: {
        overview: "REPLACE_WITH_NULL_VALUE_BLOCKED_INVALID:",
        fundamental: "REPLACE_WITH_NULL_VALUE_BLOCKED_INVALID:",
        macro: "Let me refresh the curve frame first.",
      },
    },
  ]);
  assert.equal(view?.hasDesk, false);
  assert.equal(view?.deskOverview, "");
});

test("heuristic rejects unfinished publish/render intent after markup strip", () => {
  const decision = heuristicTimelineQuality([
    { role: "user", content: "Hourly market overview" },
    {
      role: "assistant",
      content:
        "The chart and data are ready. Now I need to publish the desk view. Let me also render a second chart showing risk posture (VIX and TLT) since that's the key factor driving the tape.",
      chart: { kind: "line", x: "date", y: "close" },
    },
  ]);
  assert.equal(decision?.allow, false);
  assert.match(decision?.reason ?? "", /tool-loop|narration/i);
});

const PRIVATE_BOT_LEAK =
  "Also, since there's risk in TLT and no macro specialist active (fundamental/technical/options/risk are active). But for a private briefing I deliver full analysis directly.";

test("heuristic rejects specialist-routing leak from a private bot run (share AEaE9JM6cpbkmFuYUa2UeSON)", () => {
  const decision = heuristicTimelineQuality([
    { role: "user", content: "Review my Schwab book for concentration and expiry risk." },
    { role: "assistant", content: PRIVATE_BOT_LEAK },
  ]);
  assert.equal(decision?.allow, false);
  assert.equal(decision?.source, "heuristic");
  assert.match(decision?.reason ?? "", /tool-loop|narration/i);
});

test("heuristic allows a finished private markdown briefing without desk chrome", () => {
  const briefing = [
    "## Book",
    "Seven ETF lots. RSP is 26% of equity — the largest sleeve. IGV is the software concentration.",
    "",
    "## Risk",
    "No listed options, so no expiry or gamma. TLT is the rates sleeve; SIVR is the commodity sleeve.",
    "",
    "## Action",
    "Hold. No trim this session.",
  ].join("\n");
  const decision = heuristicTimelineQuality([
    { role: "user", content: "Review my Schwab book." },
    { role: "assistant", content: briefing },
  ]);
  assert.equal(decision, null);
});

test("healed private-bot leak is no longer a heuristic reject", () => {
  const messages = coalesceAssistantMessageRecords([
    { role: "user", content: "Review my Schwab book." },
    {
      role: "assistant",
      content: PRIVATE_BOT_LEAK,
      reasoning: [
        "The user is a private account bot owner. They attached a Schwab portfolio and want a review. I must call get_portfolio with source=\"schwab\" and account_id=\"schwab-0-3674\". Let me do that first.",
        "Let me call get_portfolio.The portfolio has 7 positions, all ETFs. Let me note them:\n- SIVR - Silver ETF, qty 75, mark $4,719.75, open PnL -$2,936 (big loss)\n- RSP - S&P 500 Equal Weight, qty 80, $17,428 (largest position ~25.8%)\n- VEU - FTSE All-World ex-US, qty 100, $8,637\n- VGSH - Short-Term Treasury, qty 80, $4,632\n- IGV - Software Sector ETF, qty 100, $10,236\n- TLT - 20+ Year Treasury, qty 100, $8,232\n- EWY - South Korea ETF, qty 25, $4,773",
        "Total equity $67,386 + cash $8,727 = ~$76,113. Buying power $141,766 (margin).",
        "Positions are all ETFs - no single-name concentrations, no options in the book (no expiry risk from options). All diversified funds. So the risk flagging is around factor/sector concentration, not single-name.",
        "Let me analyze. Positions sorted by value:\n- RSP $17,428 (25.9%)\n- IGV $10,236 (15.2%)\n- VEU $8,637 (12.8%)\n- TLT $8,232 (12.2%)\n- VGSH $4,633 (6.9%)\n- SIVR $4,720 (7.0%)\n- EWY $4,773 (7.1%)",
        "RSP is the biggest. IGV is sector concentration (software). SIVR is commodity concentration. EWY is country concentration (South Korea).",
        "No options → no delta/gamma/expiration risk in the literal sense. But the user asks about delta/gamma exposure — I'll note the book has no option positions, so no gamma/expiry. Delta = equity beta exposure.",
        "Let me identify these ETFs via lookup_symbols to get holdings/weights. And I can query etf_holdings for lake-backed data.",
        PRIVATE_BOT_LEAK,
        "Let me gather data.Let me look more deeply at the ETF holdings for IGV, EWY, and RSP to understand concentration.",
      ].join("\n\n"),
    },
  ]);
  const content = String(messages[1]?.content ?? "");
  assert.match(content, /7 positions/);
  assert.match(content, /sector concentration/);
  assert.doesNotMatch(content, /macro specialist active/);
  const decision = heuristicTimelineQuality(messages);
  assert.equal(decision, null);
});

test("moderateTimelineShare without a model still withholds the private-bot leak", async () => {
  const rejected = await moderateTimelineShare(
    [
      { role: "user", content: "Review my book." },
      { role: "assistant", content: PRIVATE_BOT_LEAK },
    ],
    null,
    { audience: "private_briefing" },
  );
  assert.equal(rejected.allow, false);
  assert.equal(rejected.source, "heuristic");

  const allowed = await moderateTimelineShare(
    [
      { role: "user", content: "Review my book." },
      {
        role: "assistant",
        content: [
          "## Book",
          "Seven ETF lots. RSP is 26% of equity — the largest sleeve.",
          "## Risk",
          "No listed options, so no expiry or gamma.",
          "## Action",
          "Hold. No trim this session.",
        ].join("\n"),
      },
    ],
    null,
    { audience: "private_briefing" },
  );
  assert.equal(allowed.allow, true);
  assert.equal(allowed.source, "fail_open");
});
