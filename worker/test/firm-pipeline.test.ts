import assert from "node:assert/strict";
import test from "node:test";
import { caseById, scoreDeskVerdict } from "../src/desk-experiment.ts";
import { buildDeskExperimentCases } from "../src/desk-experiment-cases.ts";
import {
  FIRM_ANALYST_IDS,
  FIRM_APPROACH_IDS,
  FIRM_CELL_TIMEOUT_MS,
  FIRM_PIPELINE_DESIGN_ID,
  FIRM_PIPELINE_RUNNER_VERSION,
  FIRM_PIPELINE_SLUG,
  firmPipelineDesignPublic,
  runFirmPipelineApproach,
} from "../src/firm-pipeline.ts";
import { parseFirmPipelineProbeBody } from "../src/firm-pipeline-probe.ts";

const TAKE = "This is a grounded specialist take with levels, catalysts, and a clear lean from the snapshot evidence.";
const VERDICT = '{"lean_5d":"neutral","lean_20d":"bearish","confidence_5d":0.4,"confidence_20d":0.6,"thesis":"Event IV, no spot edge."}';

function systemOf(messages: Array<{ role: string; content: string }>): string {
  return messages.find((m) => m.role === "system")?.content ?? "";
}

function packed(messages: Array<{ role: string; content: string }>): string {
  return messages.map((m) => m.content).join("\n");
}

test("firmPipelineDesignPublic reuses desk-approaches cases and exposes stages", () => {
  const design = firmPipelineDesignPublic();
  assert.equal(design.design_id, FIRM_PIPELINE_DESIGN_ID);
  assert.equal(design.slug, FIRM_PIPELINE_SLUG);
  assert.equal(design.runner_version, FIRM_PIPELINE_RUNNER_VERSION);
  assert.equal(design.cases.length, 4);
  assert.equal(design.approaches.length, 4);
  assert.deepEqual(design.approaches.map((row) => row.id), [...FIRM_APPROACH_IDS]);
  assert.equal(design.specialists.length, 4);
  assert.ok(design.specialists.some((row) => row.id === "news"));
  assert.ok(!design.specialists.some((row) => row.id === "risk"));
  assert.equal(design.runner.cell_timeout_ms, FIRM_CELL_TIMEOUT_MS);
  assert.match(design.paper.citation, /2412\.20138/);
  assert.ok(design.paper.reject.some((row) => /AAPL/i.test(row)));
  assert.equal(design.shared_with_desk_approaches.design, "desk-approaches-v2");
  for (const row of design.cases) {
    assert.ok(row.snapshot_text.includes(`AS OF ${row.as_of}`));
    assert.ok(!row.user_packet.includes(row.what_happened));
  }
});

test("parseFirmPipelineProbeBody rejects unknown ids", () => {
  const bad = parseFirmPipelineProbeBody({ approach_id: "solo", case_id: "nope" });
  assert.equal(bad.ok, false);
  const ok = parseFirmPipelineProbeBody({
    approach_id: "firm_risk_committee",
    case_id: "drift-breakdown",
    model: "deepseek/deepseek-v4-flash-0731",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.approach_id, "firm_risk_committee");
    assert.equal(ok.case_id, "drift-breakdown");
  }
});

test("solo is one verdict session on the full snapshot", async () => {
  const cove = caseById("cove-event", buildDeskExperimentCases())!;
  const kinds: Array<string | undefined> = [];
  const run = await runFirmPipelineApproach("solo", cove, async (req) => {
    kinds.push(req.kind);
    assert.match(packed(req.messages), /AS OF /);
    return { text: `Take.\n${VERDICT}`, latency_ms: 1 };
  });
  assert.deepEqual(kinds, ["verdict"]);
  assert.equal(run.session_count, 1);
  assert.equal(run.llm_calls, 1);
  assert.equal(run.verdict?.lean_5d, "neutral");
});

test("reports_then_trader isolates analysts and hands structured reports to the trader", async () => {
  const cove = caseById("cove-event", buildDeskExperimentCases())!;
  const kinds: Array<string | undefined> = [];
  const analystTexts: string[] = [];
  const run = await runFirmPipelineApproach("reports_then_trader", cove, async (req) => {
    kinds.push(req.kind);
    const sys = systemOf(req.messages);
    if (sys.includes("analyst only")) {
      const text = `${TAKE} analyst=${analystTexts.length}`;
      analystTexts.push(text);
      return { text, latency_ms: 1 };
    }
    return { text: `Trader weighing reports.\n${VERDICT}`, latency_ms: 1 };
  });
  assert.equal(run.session_count, 5);
  assert.equal(run.llm_calls, 5);
  assert.deepEqual(kinds.filter((k) => k === "verdict"), ["verdict"]);
  assert.equal(kinds.filter((k) => k !== "verdict").length, 4);
  const analysts = run.sessions.filter((s) => FIRM_ANALYST_IDS.includes(s.specialist as typeof FIRM_ANALYST_IDS[number]));
  assert.equal(analysts.length, 4);
  for (const session of analysts) {
    const others = analysts.filter((s) => s.id !== session.id).map((s) => s.text);
    const blob = packed(session.messages);
    for (const other of others) {
      assert.equal(blob.includes(other), false, `${session.id} saw another analyst take`);
    }
    assert.match(blob, /AS OF /);
  }
  const trader = run.sessions.find((s) => s.id === "trader");
  assert.ok(trader);
  const traderPack = packed(trader.messages);
  assert.match(traderPack, /STRUCTURED ANALYST REPORTS/);
  assert.match(traderPack, /FACT CHECK/);
  for (const text of analysts.map((s) => s.text)) {
    assert.ok(traderPack.includes(text));
  }
  assert.equal(run.verdict?.lean_20d, "bearish");
});

test("bull and bear do not read each other; trader sees both briefs", async () => {
  const bolt = caseById("bolt-coil", buildDeskExperimentCases())!;
  const run = await runFirmPipelineApproach("bull_bear_debate", bolt, async (req) => {
    const sys = systemOf(req.messages);
    if (sys.includes("bullish researcher")) {
      return { text: `${TAKE} BULL_MARK`, latency_ms: 1 };
    }
    if (sys.includes("bearish researcher")) {
      return { text: `${TAKE} BEAR_MARK`, latency_ms: 1 };
    }
    if (sys.includes("You are the trader")) {
      return { text: `Weigh dialectic.\n${'{"lean_5d":"bullish","lean_20d":"bullish","confidence_5d":0.6,"confidence_20d":0.5,"thesis":"Coil."}'}`, latency_ms: 1 };
    }
    return { text: `${TAKE} analyst`, latency_ms: 1 };
  });
  assert.equal(run.session_count, 7);
  const bull = run.sessions.find((s) => s.id === "bull")!;
  const bear = run.sessions.find((s) => s.id === "bear")!;
  assert.equal(packed(bull.messages).includes("BEAR_MARK"), false);
  assert.equal(packed(bear.messages).includes("BULL_MARK"), false);
  assert.match(packed(bull.messages), /STRUCTURED ANALYST REPORTS/);
  const trader = run.sessions.find((s) => s.id === "trader")!;
  assert.match(packed(trader.messages), /BULL_MARK/);
  assert.match(packed(trader.messages), /BEAR_MARK/);
  assert.equal(run.bull_brief?.includes("BULL_MARK"), true);
  assert.equal(run.verdict?.lean_5d, "bullish");
});

test("firm_risk_committee drafts then risks then fund manager verdict", async () => {
  const dune = caseById("dune-duration", buildDeskExperimentCases())!;
  const kinds: Array<string | undefined> = [];
  const run = await runFirmPipelineApproach("firm_risk_committee", dune, async (req) => {
    kinds.push(req.kind);
    const sys = systemOf(req.messages);
    if (sys.includes("You are the trader")) {
      assert.equal(req.kind, "prose");
      assert.match(sys, /Do not emit verdict JSON/);
      return { text: `${TAKE} DRAFT_MARK fade duration.`, latency_ms: 1 };
    }
    if (sys.includes("risk-seeking")) {
      return { text: `${TAKE} AGG_MARK size up if yields stall.`, latency_ms: 1 };
    }
    if (sys.includes("risk-conservative")) {
      return { text: `${TAKE} CON_MARK stand down into the auction.`, latency_ms: 1 };
    }
    if (sys.includes("You are the fund manager")) {
      assert.equal(req.kind, "verdict");
      const blob = packed(req.messages);
      assert.match(blob, /DRAFT_MARK/);
      assert.match(blob, /AGG_MARK/);
      assert.match(blob, /CON_MARK/);
      return {
        text: `${TAKE} keep the fade.\n${'{"lean_5d":"bearish","lean_20d":"bearish","confidence_5d":0.7,"confidence_20d":0.7,"thesis":"Yields already rising."}'}`,
        latency_ms: 1,
      };
    }
    return { text: `${TAKE} seat`, latency_ms: 1 };
  });
  assert.equal(run.session_count, 10);
  assert.equal(run.llm_calls, 10);
  assert.equal(kinds.filter((k) => k === "verdict").length, 1);
  assert.equal(run.trader_draft?.includes("DRAFT_MARK"), true);
  assert.equal(run.risk_aggressive?.includes("AGG_MARK"), true);
  assert.equal(run.risk_conservative?.includes("CON_MARK"), true);
  const score = scoreDeskVerdict(run.verdict, dune);
  assert.equal(score.correct, true);
});

test("risk is not a parallel analyst in this study", () => {
  const design = firmPipelineDesignPublic();
  assert.ok(design.stages.some((row) => row.id === "risk"));
  const reports = design.approach_inputs.find((row) => row.id === "reports_then_trader");
  assert.ok(reports && "specialist_system" in reports);
  if (reports && "specialist_system" in reports && reports.specialist_system) {
    assert.equal("risk" in reports.specialist_system, false);
    assert.equal("news" in reports.specialist_system, true);
  }
});
