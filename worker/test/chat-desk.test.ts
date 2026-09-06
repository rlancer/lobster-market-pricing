import assert from "node:assert/strict";
import test from "node:test";
import {
  DESK_CORE_VIEWPOINT_IDS,
  clipDeskMarkdown,
  deskAnalystBlock,
  deskViewpointsFromBrief,
  formatDeskToolSummary,
  isDeskStubText,
  normalizeDeskBrief,
} from "../src/chat-desk.ts";
import { selectDeskSpecialists } from "../src/chat-desk-route.ts";

test("normalizeDeskBrief requires core fields when required is set", () => {
  assert.equal(normalizeDeskBrief({
    fundamental: "",
    technical: "trend up with ordered volume into support after the squeeze.",
    options: "call debit near ATM with two-sided quotes and usable open interest.",
    risk: "A gap through support and a liquidity vacuum wipe the debit before the thesis can play.",
    overview: "net bullish with defined risk while liquidity holds up on the book.",
  }, { required: DESK_CORE_VIEWPOINT_IDS }), null);

  const desk = normalizeDeskBrief({
    fundamental: "EPS beat, guidance raised with durable services mix still expanding.",
    technical: "Holding above the 21d MA after a tight consolidation range.",
    options: "Near-ATM calls quote two-sided with usable open interest.",
    risk: "A guidance cut or bid vacuum into the print can erase the debit before the thesis plays.",
    overview: "Lean bullish with defined risk while liquidity holds up.",
  }, { required: DESK_CORE_VIEWPOINT_IDS });
  assert.ok(desk);
  assert.match(desk.fundamental!, /EPS beat/);
  assert.ok(desk.risk);
  assert.equal(deskViewpointsFromBrief(desk).length, 4);
  assert.match(formatDeskToolSummary(desk), /Desk viewpoints published/);
});

test("normalizeDeskBrief accepts routed subset with risk/macro", () => {
  const desk = normalizeDeskBrief({
    technical: "SPY holding the 50d with rising volume on the bounce from support.",
    options: "Near-term put skew is bid ahead of the CPI print next week.",
    macro: "Real yields soft overnight; duration bid lifts beta while the dollar slips.",
    risk: "A hot CPI reprint gaps the index and blows up short-dated premium sellers.",
    overview: "Macro-friendly tape into CPI with defined-risk preference on the index.",
  }, { required: ["technical", "options", "macro", "risk"] });
  assert.ok(desk);
  assert.equal(desk.fundamental, undefined);
  assert.ok(desk.macro);
  assert.ok(desk.risk);
  assert.equal(deskViewpointsFromBrief(desk).map((v) => v.id).join(","), "technical,options,risk,macro");
});

test("normalizeDeskBrief drops stub extras but keeps required takes", () => {
  const desk = normalizeDeskBrief({
    fundamental: "EPS beat, guidance raised with durable services mix still expanding.",
    technical: "Holding above the 21d MA after a tight consolidation range.",
    options: "Near-ATM calls quote two-sided with usable open interest.",
    risk: "A guidance cut or bid vacuum into the print can erase the debit before the thesis plays.",
    macro: "placeholder",
    overview: "Lean bullish with defined risk while liquidity holds up.",
  }, { required: DESK_CORE_VIEWPOINT_IDS });
  assert.ok(desk);
  assert.equal(desk.macro, undefined);
  assert.ok(desk.risk);
});

test("normalizeDeskBrief rejects protocol-echo Received stubs", () => {
  // Regression: share wnJWqaRxtCu1I3CLJIgCiaon — DeepSeek echoed tool-call
  // protocol crumbs that cleared the 40-char minimum and listed on the Floor.
  assert.equal(normalizeDeskBrief({
    fundamental: "Received: ... first include Text & 'Received'",
    technical: "Received: ... first include Text Received",
    options: "Received: ... first include the Text Received",
    risk: "Received: ... first include Text Received",
    macro: "Received: ... first include Text 'Received'",
    overview: "Received: ... first include Text 'Received'",
  }, { required: DESK_CORE_VIEWPOINT_IDS }), null);
});

test("isDeskStubText treats blocked-null sanitizer tokens as stubs", () => {
  // Regression: share 1qKRZL7BSEpll6HDPoypuU8bS — publish_desk leftover.
  assert.equal(isDeskStubText("REPLACE_WITH_NULL_VALUE_BLOCKED_INVALID:"), true);
  assert.equal(isDeskStubText("replace_with_null_value_blocked_invalid"), true);
  assert.equal(isDeskStubText("Mild-bullish: ride the 310/320 bull call into the weekly."), false);
});

test("normalizeDeskBrief rejects placeholder stubs", () => {
  // Regression: GME share ynQcuupDNBG04fcaYleY01hi — forced publish_desk emitted
  // literal "placeholder" and the loop sealed before a real desk could land.
  assert.equal(normalizeDeskBrief({
    fundamental: "placeholder",
    technical: "placeholder",
    options: "placeholder",
    risk: "placeholder",
    overview: "placeholder",
  }, { required: DESK_CORE_VIEWPOINT_IDS }), null);
  assert.equal(normalizeDeskBrief({
    fundamental: "TBD",
    technical: "Holding above the 21d MA after a tight consolidation range.",
    options: "Near-ATM calls quote two-sided with usable open interest.",
    risk: "A guidance cut or bid vacuum into the print can erase the debit before the thesis plays.",
    overview: "Lean bullish with defined risk while liquidity holds up.",
  }, { required: DESK_CORE_VIEWPOINT_IDS }), null);
});

test("normalizeDeskBrief recovers partial historical desks without required", () => {
  const desk = normalizeDeskBrief({
    options: "Near-ATM calls quote two-sided with usable open interest on the chain.",
    overview: "Chain looks tradeable near ATM with defined-risk preference.",
  });
  assert.ok(desk);
  assert.equal(deskViewpointsFromBrief(desk).length, 1);
});

test("deskAnalystBlock names all specialists, routing, and publish_desk", () => {
  const block = deskAnalystBlock(["fundamental", "technical", "options", "risk"]);
  assert.match(block, /Fundamental analyst/);
  assert.match(block, /Technical analyst/);
  assert.match(block, /Options/);
  assert.match(block, /Risk analyst/);
  assert.match(block, /Macro analyst/);
  assert.match(block, /Active specialists for this turn/);
  assert.match(block, /Fundamental, Technical, Options, Risk/);
  assert.match(block, /publish_desk/);
  assert.match(block, /suggest_trades/);
  assert.match(block, /placeholder/);
  assert.match(block, /Never overweight technical analysis/);
  assert.match(block, /GME/);
  assert.match(block, /SPY/);
  assert.match(block, /Risk is always active/);
  assert.match(block, /Write specialist takes, the overview, and the closing message as Markdown/);
  assert.match(block, /Never one run-on sentence/);
});

test("clipDeskMarkdown keeps blank-line paragraphs and lists", () => {
  const md = [
    "**Lean:** stay with the steeper.",
    "",
    "The long end is carrying the load:",
    "",
    "- **30Y** 5.27%",
    "- **2s10s** +43bp",
  ].join("\n");
  assert.equal(clipDeskMarkdown(md, 2_400), md);
  assert.match(clipDeskMarkdown(md, 2_400), /\n\n- \*\*30Y\*\*/);
});

test("clipDeskMarkdown cuts at a paragraph boundary when over budget", () => {
  const para = "The Fed is quietly neutral and the long end is carrying the load. ";
  const md = [`**Lean:** stay with the steeper.`, "", para.repeat(80)].join("\n");
  const clipped = clipDeskMarkdown(md, 50);
  assert.ok(clipped.length <= 50);
  assert.equal(clipped, "**Lean:** stay with the steeper.…");
  assert.doesNotMatch(clipped, /The Fed is quietly/);
});

test("normalizeDeskBrief preserves Markdown instead of flattening to one line", () => {
  const take = [
    "**Lean:** stay with the steeper.",
    "",
    "The long end is carrying the load:",
    "",
    "- **30Y** 5.27% near the cycle high",
    "- **2s10s** +43bp and fragile into CPI",
  ].join("\n");
  const desk = normalizeDeskBrief({
    fundamental: `${take}\n\nCore PCE is the problem child on this print.`,
    technical: `${take}\n\nPrice holds the 21-day average after the squeeze.`,
    options: `${take}\n\nNear-ATM calls quote two-sided with usable open interest.`,
    risk: `${take}\n\nA hot CPI reprint gaps the belly and blows up short-dated premium.`,
    overview: `${take}\n\nLet the 9/11 CPI print set the next curve trade.`,
  }, { required: DESK_CORE_VIEWPOINT_IDS });
  assert.ok(desk);
  assert.match(desk.overview, /\n\n- \*\*30Y\*\*/);
  assert.match(desk.overview, /\n\nLet the 9\/11 CPI/);
  assert.doesNotMatch(desk.overview, /steeper\. The long end is carrying/);
});

test("selectDeskSpecialists skips macro for single-name options chain", () => {
  const specialists = selectDeskSpecialists("show me the GME options chain");
  assert.deepEqual(specialists, ["fundamental", "technical", "options", "risk"]);
  assert.ok(!specialists.includes("macro"));
});

test("selectDeskSpecialists adds macro for SPY and TLT", () => {
  assert.ok(selectDeskSpecialists("what's going on with SPY?").includes("macro"));
  assert.ok(selectDeskSpecialists("TLT outlook into the next FOMC").includes("macro"));
  assert.ok(selectDeskSpecialists("how does CPI affect QQQ?").includes("macro"));
});

test("selectDeskSpecialists always includes risk on analysis desks", () => {
  assert.ok(selectDeskSpecialists("analyze NVDA earnings and the options chain").includes("risk"));
  assert.ok(selectDeskSpecialists("show me the GME options chain").includes("risk"));
  assert.ok(selectDeskSpecialists("what's going on with SPY?").includes("risk"));
  const hedge = selectDeskSpecialists("how do I hedge AAPL downside into earnings?");
  assert.ok(hedge.includes("risk"));
  assert.ok(hedge.includes("fundamental"));
  assert.ok(!hedge.includes("macro"));
});

test("selectDeskSpecialists uses macro tape without equity fundamentals for broad market", () => {
  const specialists = selectDeskSpecialists("macro view on TLT and rates into the Fed meeting");
  assert.deepEqual(specialists, ["technical", "options", "risk", "macro"]);
});

test("selectDeskSpecialists uses bot persona context so a rates bot still gets macro", () => {
  const specialists = selectDeskSpecialists(
    "What is the US Treasury curve doing?",
    "Rates, the curve, and the cycle\nYou are the macro / rates desk. Lead with options.yields.",
  );
  assert.ok(specialists.includes("macro"));
  assert.ok(specialists.includes("technical"));
});
