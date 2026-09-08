import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCaptureToShareTurns,
  coalesceAssistantMessageRecords,
  coalesceAssistantShareTurns,
  promoteReasoningTakeaway,
  type ShareTurn,
} from "../src/share-turns.ts";

test("coalesceAssistantShareTurns merges consecutive recovery assistants", () => {
  const turns: ShareTurn[] = [
    { role: "user", content: "what do you think of going long uber?" },
    { role: "assistant", content: "" },
    {
      role: "assistant",
      content: "",
      reasoning: "The user is asking about going long Uber. Let me research.",
      sql: "SELECT 1",
    },
    {
      role: "assistant",
      content: "",
      reasoning: "The user is asking about going long Uber again after recovery.",
      sql: "SELECT earnings_date FROM options.earnings WHERE symbol = 'UBER'",
    },
  ];
  const out = coalesceAssistantShareTurns(turns);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].role, "assistant");
  assert.equal(out[1].sql, "SELECT earnings_date FROM options.earnings WHERE symbol = 'UBER'");
  assert.deepEqual(out[1].queries, [
    "SELECT 1",
    "SELECT earnings_date FROM options.earnings WHERE symbol = 'UBER'",
  ]);
  assert.match(out[1].reasoning ?? "", /after recovery/);
  // Promote lifts the sealed reasoning paragraph into visible content.
  assert.match(out[1].content, /after recovery/);
});

test("coalesceAssistantMessageRecords drops null-token desks", () => {
  const out = coalesceAssistantMessageRecords([
    { role: "user", content: "curve?" },
    {
      role: "assistant",
      content: "Let me refresh the curve frame first.",
      desk: {
        overview: "REPLACE_WITH_NULL_VALUE_BLOCKED_INVALID:",
        fundamental: "REPLACE_WITH_NULL_VALUE_BLOCKED_INVALID:",
        macro: "The frame last was overwritten. Let me call render_chart.",
      },
    },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].desk, undefined);
});

test("coalesceAssistantShareTurns prefers desk overview as content", () => {
  const turns: ShareTurn[] = [
    { role: "user", content: "Long UBER?" },
    { role: "assistant", content: "Let me query…", reasoning: "scratch" },
    {
      role: "assistant",
      content: "mid-turn",
      desk: {
        fundamental: "Uber's ride mix and margins look constructive on the latest print.",
        technical: "Price holds above the 21-day rising average with constructive volume.",
        options: "Oct puts still bid; defined-risk call spreads remain liquid near ATM.",
        overview: "Constructive long: fundamentals and tape agree; size via defined-risk calls.",
      },
    },
  ];
  const out = coalesceAssistantShareTurns(turns);
  assert.equal(out.length, 2);
  assert.equal(
    out[1].content,
    "Constructive long: fundamentals and tape agree; size via defined-risk calls.",
  );
  assert.ok(out[1].desk);
});

test("coalesceAssistantMessageRecords heals stored multi-bubble shares", () => {
  const out = coalesceAssistantMessageRecords([
    { role: "user", content: "long uber?" },
    { role: "assistant" },
    { role: "assistant", reasoning: "first attempt", sql: "SELECT a" },
    { role: "assistant", reasoning: "second attempt", sql: "SELECT b", result: { columns: ["b"], rows: [] } },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].sql, "SELECT b");
  assert.deepEqual(out[1].queries, ["SELECT a", "SELECT b"]);
  assert.equal(out[1].reasoning, "second attempt");
  assert.deepEqual(out[1].result, { columns: ["b"], rows: [] });
});

test("promoteReasoningTakeaway lifts a conclusive reasoning paragraph into content", () => {
  const turned = promoteReasoningTakeaway({
    role: "assistant",
    content: "(see reasoning)",
    reasoning: [
      "Plan of tool calls:",
      "Batch 1: run_query for SPY/QQQ closes.",
      "",
      "Risk-off into the close: SPX and QQQ fade while VIX and TLT catch a bid. Stay light until the open confirms.",
    ].join("\n"),
    chart: { kind: "line", x: "date", y: "close" },
  });
  assert.match(turned.content, /Risk-off into the close/);
  assert.doesNotMatch(turned.content, /Plan of tool/i);
});

test("promoteReasoningTakeaway replaces interim narration with substantive reasoning paragraphs and skips trailing scratch", () => {
  const turned = promoteReasoningTakeaway({
    role: "assistant",
    content: "SBNY is actually Signature Bank. Let me pull ETF holdings and rate context to finish the picture.",
    reasoning: [
      "Let me review the portfolio.",
      "",
      "Book breakdown:\n- SBNY: stranded delisted bank equity\n- RSP: broad equal-weight beta",
      "",
      "Concentration flags:\n1. SBNY is unmarketable\n2. IGV is software sector concentration",
      "",
      "Actions:\n1. SBNY write-off\n2. Trim IGV into strength",
      "",
      "Let me write the private briefing in markdown. No publish_desk.",
    ].join("\n\n"),
  });
  assert.match(turned.content, /Book breakdown:/);
  assert.match(turned.content, /Concentration flags:/);
  assert.match(turned.content, /Actions:/);
  assert.doesNotMatch(turned.content, /Let me write the private briefing/);
  assert.doesNotMatch(turned.content, /Let me pull ETF holdings/);
});

test("promoteReasoningTakeaway skips unfinished let-me narration", () => {
  const turned = promoteReasoningTakeaway({
    role: "assistant",
    content: "(see reasoning)",
    reasoning: "Let me query the options tape and then pull another window for the chart.",
  });
  assert.equal(turned.content, "(see reasoning)");
});

test("promoteReasoningTakeaway skips a leaked weight scratchpad and lifts the briefing (share S2xd3YVSuwjYaByfdF1cw0HL)", () => {
  const weights = [
    "Compute weights again precisely:",
    "Equity total 67,656.01. Add cash 8,727.33 = 76,383.34.",
    "- RSP 17,563.20 / 67,656 = 25.96%",
    "- IGV 10,477.00 = 15.49%",
    "Cash = 11.4% of total.",
  ].join("\n");
  const beta = "Equity beta concentration: RSP+IGV+VEU+EWY (equities) = 61.1% of equity. SIVR silver 7%, Treasuries TLT+VGSH 19%. So equity+silver ~68% risk assets.";
  const leak = `${weights}\n\n${beta}`;
  const turned = promoteReasoningTakeaway({
    role: "assistant",
    content: leak,
    reasoning: [
      "The owner attached a Schwab portfolio. I must call get_portfolio.",
      "Let me start by loading the portfolio.",
      "Portfolio (equity $67,656 + cash $8,727; margin account, buying power $141,767 which is 2x equity):\n- RSP (S&P 500 EW) 80 sh $17,563 (26.0% of equity) +$896.15\n- IGV (software) 100 sh $10,477 (15.5%) +$1,558\n- SIVR (silver) 75 sh $4,713 (7.0%) -$2,942.78 (biggest loser)",
      "Concentration:\n- No single-name stock positions — all ETFs.\n- IGV is software sector concentration at 15.5% of equity.\n- EWY is single-country Korea with Samsung+SK Hynix ~45% of that sleeve.",
      "Key risk / adjustments before next session:\n1. SIVR is the biggest drag (-$2.9k open, 37% vol) — trim or exit.\n2. IGV software at 15.5% is high-beta — consider trimming toward RSP.\n3. TLT 12% long duration is a directional rates bet.",
      "Next-session actions with concrete numbers:\n- Trim SIVR (silver, -$2.9k open, 37% vol).\n- Trim IGV 15.5% software sleeve toward RSP.\n- Consider capping TLT duration exposure.",
      "Let me write the briefing directly in markdown. No publish_desk (private bot).",
      "Let me write a comprehensive briefing.",
      weights,
      beta,
      "Good. Write it.",
    ].join("\n\n"),
  });
  assert.match(turned.content, /Next-session actions/);
  assert.match(turned.content, /Key risk \/ adjustments/);
  assert.match(turned.content, /Concentration:/);
  assert.doesNotMatch(turned.content, /Compute weights again precisely/);
  assert.doesNotMatch(turned.content, /Good\. Write it/);
  assert.doesNotMatch(turned.content, /Let me write the briefing/);
  // Second read must keep the briefing — anywhere-includes used to collapse
  // it to the trailing "Equity beta concentration" paragraph on api-dev.
  const again = promoteReasoningTakeaway(turned);
  assert.equal(again.content, turned.content);
});

test("promoteReasoningTakeaway heals eco_calendar meta leak into content (share gpAJwLq)", () => {
  const meta = "I don't need eco_calendar here since no macro event catalyst question. All good.";
  const turned = promoteReasoningTakeaway({
    role: "assistant",
    content: meta,
    reasoning: [
      "The user attached a Schwab book. Load get_portfolio first.",
      "",
      "So the real book-level observations:\n1. Delta/beta-heavy: 61% equity with IGV+EWY as the high-vol sleeves.\n2. EWY is 64-74% realized vol with two-stock concentration.\n3. TLT long-duration is rate-sensitive. Short duration VGSH is stable.\n4. Cash 11.4% — adequate dry powder, plus buying power $141.7k (margin).",
      "",
      "Overlap check: no single-name concentration at book level — good. The only issuer-heavy sleeve is EWY (two-stock-driven single country).",
      "",
      "Adjustments to consider:\n1. Trim EWY if not a conviction bet.\n2. Reconsider TLT duration size.\n3. SIVR is bleeding hardest — decide the silver thesis.",
      "",
      "Actions list:\n- Trim EWY or add stop discipline given 64-74% vol.\n- Reconsider TLT duration size (or accept as rates view).\n- SIVR: decide silver thesis; bleeding hardest.\n- Keep RSP as core; VEU/VGSH fine as ballast.\n- Cash ~11% is a fine buffer.",
      "",
      "Let me also verify the T10Y2Y — my query excluded it since no nominal row returned.",
      "",
      meta,
      "",
      "Now write the direct markdown briefing. No publish_desk (private bot). I'll skip suggest_trades; deliver the actions in prose.",
      "",
      "Actually — \"suggest_trades is optional and only when a concrete adjustment is tradable.\" I'll keep it prose-only to avoid over-tooling; the briefing is the deliver",
    ].join("\n\n"),
    sql: "SELECT series_id FROM options.yields WHERE series_id IN ('DGS2','DGS10','DGS30')",
  });
  assert.match(turned.content, /Actions list:/);
  assert.match(turned.content, /book-level observations/);
  assert.match(turned.content, /Adjustments to consider/);
  assert.doesNotMatch(turned.content, /eco_calendar/);
  assert.doesNotMatch(turned.content, /briefing is the deliver/);
  assert.doesNotMatch(turned.content, /Now write the direct markdown/);
});

test("promoteReasoningTakeaway skips trailing weight-recompute and lifts the briefing (share S2xd3YV)", () => {
  // Private portfolio bot: full review lives in reasoning; the last seal step
  // recopied sleeve math into the visible channel ("Compute weights again").
  const weights = [
    "Compute weights again precisely:",
    "Equity total 67,656.01. Add cash 8,727.33 = 76,383.34.",
    "- RSP 17,563.20 / 67,656 = 25.96%",
    "- IGV 10,477.00 = 15.49%",
    "- VEU 8,640.50 = 12.77%",
    "- TLT 8,234.65 = 12.17%",
    "- SIVR 4,713.38 = 6.97%",
    "- VGSH 4,633.20 = 6.85%",
    "- EWY 4,666.75 = 6.90%",
    "Cash = 11.4% of total.",
  ].join("\n");
  const beta = "Equity beta concentration: RSP+IGV+VEU+EWY (equities) = 25.96+15.49+12.77+6.90 = 61.1% of equity. SIVR silver 7%, Treasuries TLT+VGSH 19%. So equity+silver ~68% risk assets.";
  const turned = promoteReasoningTakeaway({
    role: "assistant",
    content: `${weights}\n\n${beta}`,
    reasoning: [
      "The owner attached a Schwab portfolio. Private account bot — no publish_desk.",
      "",
      "Portfolio (equity $67,656 + cash $8,727): RSP 26%, IGV 15.5%, VEU 12.8%, TLT 12.2%, SIVR 7%, VGSH 6.8%, EWY 6.9%.",
      "",
      "Concentration:\n- No single-name stock positions — all ETFs.\n- IGV is software sector concentration at 15.5% of equity.\n- EWY is single-country Korea; Samsung+SK Hynix ~45% of that sleeve.",
      "",
      "Key risk / adjustments before next session:\n1. SIVR is the biggest drag (-$2.9k open, 37% vol) — trim or exit.\n2. IGV software at 15.5% is high-beta — consider trimming toward RSP.\n3. TLT 12% is a large duration bet.",
      "",
      "Next-session actions with concrete numbers:\n- Trim SIVR (silver, -$2.9k open, 37% vol).\n- Trim IGV 15.5% software sleeve toward RSP.\n- Consider capping TLT duration exposure.",
      "",
      "Let me write the briefing directly in markdown. No publish_desk (private bot).",
      "",
      "Let me write a comprehensive briefing.",
      "",
      weights,
      "",
      beta,
      "",
      "Good. Write it.",
    ].join("\n\n"),
  });
  assert.match(turned.content, /Next-session actions/);
  assert.match(turned.content, /Trim SIVR/);
  assert.match(turned.content, /Concentration:/);
  assert.doesNotMatch(turned.content, /Compute weights again/);
  assert.doesNotMatch(turned.content, /Good\. Write it/);
  assert.doesNotMatch(turned.content, /Let me write the briefing/);
});

test("coalesceAssistantMessageRecords heals weight-recompute shares on read", () => {
  const weights = "Compute weights again precisely:\n- RSP 25.96%\n- IGV 15.49%\n- VEU 12.77%\n- TLT 12.17%";
  const out = coalesceAssistantMessageRecords([
    { role: "user", content: "Review my attached portfolio." },
    {
      role: "assistant",
      content: weights,
      reasoning: [
        "Book is all long ETFs. No option expiry or gamma.",
        "",
        "Next-session actions with concrete numbers:\n- Trim SIVR on the 37% vol sleeve.\n- Hold RSP as the core equal-weight beta.",
        "",
        "Let me write the private briefing in markdown. No publish_desk.",
        "",
        weights,
        "",
        "Good. Write it.",
      ].join("\n\n"),
    },
  ]);
  assert.match(String(out[1]?.content), /Next-session actions/);
  assert.doesNotMatch(String(out[1]?.content), /Compute weights again/);
});

test("coalesceAssistantMessageRecords promotes leaked reasoning on public share read", () => {
  const meta = "I don't need eco_calendar here since no macro event catalyst question. All good.";
  const out = coalesceAssistantMessageRecords([
    { role: "user", content: "Review my attached portfolio." },
    {
      role: "assistant",
      content: meta,
      reasoning: [
        "Portfolio loaded.",
        "",
        "Concentration: RSP is 26% of book; IGV is the high-beta software sleeve; EWY is single-country risk.",
        "",
        "Actions list:\n- Trim EWY on vol.\n- Hold RSP as core.\n- Cash buffer looks fine.",
        "",
        meta,
        "",
        "Now write the direct markdown briefing. No publish_desk.",
      ].join("\n\n"),
      sql: "SELECT 1",
    },
  ]);
  assert.equal(out.length, 2);
  assert.match(String(out[1].content), /Actions list:/);
  assert.doesNotMatch(String(out[1].content), /eco_calendar/);
});

test("coalesceAssistantMessageRecords drops protocol-echo desks and planning copy", () => {
  const out = coalesceAssistantMessageRecords([
    {
      role: "user",
      content: "Hourly market overview: what's happening right now? Lead with SPX/QQQ/IWM.",
    },
    {
      role: "assistant",
      content:
        "Since this is a broad market overview ask, I should charter the index series and check a few sector ETFs for leadership. Let me grab sector ETF closes (XLK tech, XLF financials, XLE energy, XLU utilities, XLV healthcare) for the recent week, plus maybe EWY to explain the flow.",
      reasoning: "The latest data is around 2026-09-04. Let me re-query SPY and QQQ.",
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
  assert.equal(out.length, 2);
  assert.equal(out[1]?.desk, undefined);
  assert.equal(String(out[1]?.content ?? "").trim(), "");
});

test("applyCaptureToShareTurns promotes reasoning after recovering chart/sql", () => {
  const out = applyCaptureToShareTurns(
    [
      { role: "user", content: "Hourly overview" },
      {
        role: "assistant",
        content: "(see reasoning)",
        reasoning: "Planning queries.\n\nSPY leads QQQ; IWM lags as the tape stays risk-off into the close.",
      },
    ],
    { sql: "SELECT 1", chart: { kind: "line", x: "date", y: "close" } },
    "Hourly overview",
  );
  assert.match(out[1]!.content, /SPY leads QQQ/);
  assert.ok(out[1]!.chart);
  assert.equal(out[1]!.sql, "SELECT 1");
});

test("promoteReasoningTakeaway heals specialist-routing leak (share AEaE9JM6cpbkmFuYUa2UeSON)", () => {
  const leak =
    "Also, since there's risk in TLT and no macro specialist active (fundamental/technical/options/risk are active). But for a private briefing I deliver full analysis directly.";
  const turned = promoteReasoningTakeaway({
    role: "assistant",
    content: leak,
    reasoning: [
      "The user is a private account bot owner. They attached a Schwab portfolio and want a review. I must call get_portfolio with source=\"schwab\" and account_id=\"schwab-0-3674\". Let me do that first.",
      "Let me call get_portfolio.The portfolio has 7 positions, all ETFs. Let me note them:\n- SIVR - Silver ETF, qty 75, mark $4,719.75, open PnL -$2,936 (big loss)\n- RSP - S&P 500 Equal Weight, qty 80, $17,428 (largest position ~25.8%)\n- VEU - FTSE All-World ex-US, qty 100, $8,637\n- VGSH - Short-Term Treasury, qty 80, $4,632\n- IGV - Software Sector ETF, qty 100, $10,236\n- TLT - 20+ Year Treasury, qty 100, $8,232\n- EWY - South Korea ETF, qty 25, $4,773",
      "Positions are all ETFs - no single-name concentrations, no options in the book (no expiry risk from options). All diversified funds. So the risk flagging is around factor/sector concentration, not single-name.",
      "Let me analyze. Positions sorted by value:\n- RSP $17,428 (25.9%)\n- IGV $10,236 (15.2%)\n- VEU $8,637 (12.8%)\n- TLT $8,232 (12.2%)\n- VGSH $4,633 (6.9%)\n- SIVR $4,720 (7.0%)\n- EWY $4,773 (7.1%)",
      "RSP is the biggest. IGV is sector concentration (software). SIVR is commodity concentration. EWY is country concentration (South Korea).",
      "No options → no delta/gamma/expiration risk in the literal sense. Delta = equity beta exposure.",
      leak,
      "Let me gather data.Let me look more deeply at the ETF holdings for IGV, EWY, and RSP to understand concentration.",
    ].join("\n\n"),
    sql: "SELECT 1 AS dummy FROM options.securities LIMIT 1",
  });
  assert.match(turned.content, /7 positions/);
  assert.match(turned.content, /sector concentration/);
  assert.match(turned.content, /no delta\/gamma\/expiration risk/i);
  assert.doesNotMatch(turned.content, /macro specialist active/);
  assert.doesNotMatch(turned.content, /private briefing I deliver/);
  assert.doesNotMatch(turned.content, /Let me call get_portfolio/);
  const again = promoteReasoningTakeaway(turned);
  assert.equal(again.content, turned.content);
});

test("promoteReasoningTakeaway skips the AEaE9J planning tail and lifts the book review", () => {
  const leak =
    "Also, since there's risk in TLT and no macro specialist active (fundamental/technical/options/risk are active). But for a private briefing I deliver full analysis directly.";
  const turned = promoteReasoningTakeaway({
    role: "assistant",
    content: leak,
    reasoning: [
      "The user is a private account bot owner. They attached a Schwab portfolio and want a review. I must call get_portfolio with source=\"schwab\" and account_id=\"schwab-0-3674\". Let me do that first.",
      "Let me call get_portfolio.The portfolio has 7 positions, all ETFs. Let me note them:\n- SIVR - Silver ETF, qty 75, mark $4,719.75, open PnL -$2,936 (big loss)\n- RSP - S&P 500 Equal Weight, qty 80, $17,428 (largest position ~25.8%)\n- VEU - FTSE All-World ex-US, qty 100, $8,637\n- VGSH - Short-Term Treasury, qty 80, $4,632\n- IGV - Software Sector ETF, qty 100, $10,236\n- TLT - 20+ Year Treasury, qty 100, $8,232\n- EWY - South Korea ETF, qty 25, $4,773",
      "Total equity $67,386 + cash $8,727 = ~$76,113. Buying power $141,766 (margin).",
      "Positions are all ETFs - no single-name concentrations, no options in the book (no expiry risk from options). All diversified funds. So the risk flagging is around factor/sector concentration, not single-name.",
      "Let me analyze. Positions sorted by value:\n- RSP $17,428 (25.9%)\n- IGV $10,236 (15.2%)\n- VEU $8,637 (12.8%)\n- TLT $8,232 (12.2%)\n- VGSH $4,633 (6.9%)\n- SIVR $4,720 (7.0%)\n- EWY $4,773 (7.1%)",
      "RSP is the biggest. IGV is sector concentration (software). SIVR is commodity concentration. EWY is country concentration (South Korea).",
      "No options → no delta/gamma/expiration risk in the literal sense. But the user asks about delta/gamma exposure — I'll note the book has no option positions, so no gamma/expiry. Delta = equity beta exposure.",
      "Let me identify these ETFs via lookup_symbols to get holdings/weights. And I can query etf_holdings for lake-backed data.",
      "Let me recognize this is a private bot risk route — I do NOT call publish_desk. I deliver direct markdown. suggest_trades optional only when concrete adjustment is tradable.",
      "Let me call lookup_symbols on SIVR, RSP, VEU, VGSH, IGV, TLT, EWY. And query etf_holdings for IGV and EWY top members.",
      leak,
      "Let me gather data.Let me look more deeply at the ETF holdings for IGV, EWY, and RSP to understand concentration. Also, I should check recent performance/volatility for these ETFs, and look for any expiry/delta issues (none of these are options — they're all ETFs, no options in the portfolio). Let me get the full holdings detail for the top-weighted names.",
    ].join("\n\n"),
  });
  assert.ok(turned.content.length > 800, `expected lifted briefing, got ${turned.content.length} chars`);
  assert.match(turned.content, /7 positions/);
  assert.match(turned.content, /sector concentration/);
  assert.match(turned.content, /no option positions/i);
  assert.doesNotMatch(turned.content, /macro specialist active/);
  assert.doesNotMatch(turned.content, /And query etf_holdings/);
  assert.doesNotMatch(turned.content, /private account bot owner/);
  assert.doesNotMatch(turned.content, /Let me call get_portfolio/);
});
