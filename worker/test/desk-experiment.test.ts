import assert from "node:assert/strict";
import test from "node:test";
import {
  DESK_EXPERIMENT_DEADBAND_PCT,
  extractDeskVerdict,
  extractLastJsonObject,
  leanFromReturn,
  parseLean,
  runDeskApproach,
  scoreDeskVerdict,
  signedLeanScore,
} from "../src/desk-experiment.ts";
import {
  DESK_EXPERIMENT_AS_OF_INDEX,
  buildDeskExperimentCases,
  formatDeskSnapshot,
  snapshotAsOfViolations,
} from "../src/desk-experiment-cases.ts";
import { parseDeskExperimentProbeBody, deskCompletionText, resolveDeskExperimentModel, splitSystemMessages } from "../src/desk-experiment-probe.ts";

test("as-of snapshots never leak post-as-of OHLC or news", () => {
  const cases = buildDeskExperimentCases();
  assert.equal(cases.length, 4);
  for (const row of cases) {
    const asOf = row.snapshot.as_of;
    assert.equal(row.snapshot.ohlc.length, DESK_EXPERIMENT_AS_OF_INDEX + 1);
    assert.ok(row.snapshot.ohlc.every((bar) => bar.date <= asOf));
    assert.equal(row.snapshot.ohlc.at(-1)?.date, asOf);
    assert.equal(row.snapshot.ohlc.at(-1)?.close, row.outcome.close_as_of);
    assert.deepEqual(snapshotAsOfViolations(row.snapshot), []);
    const text = formatDeskSnapshot(row.snapshot);
    assert.match(text, new RegExp(`AS OF ${asOf}`));
    assert.ok(!row.snapshot.ohlc.some((bar) => bar.date > asOf));
    assert.notEqual(row.outcome.close_5d, row.outcome.close_as_of);
    assert.notEqual(row.outcome.close_20d, row.outcome.close_as_of);
  }
});

test("held-out 5d/20d closes differ from as-of and produce a lean", () => {
  const cases = buildDeskExperimentCases();
  const byId = Object.fromEntries(cases.map((row) => [row.id, row]));
  const drift = byId["drift-breakdown"]!;
  const bolt = byId["bolt-coil"]!;
  const cove = byId["cove-event"]!;
  const dune = byId["dune-duration"]!;

  assert.equal(leanFromReturn(drift.outcome.return_5d_pct), "bearish");
  assert.equal(leanFromReturn(drift.outcome.return_20d_pct), "bearish");
  assert.equal(leanFromReturn(bolt.outcome.return_5d_pct), "bullish");
  assert.equal(leanFromReturn(bolt.outcome.return_20d_pct), "bullish");
  assert.equal(leanFromReturn(cove.outcome.return_5d_pct), "neutral");
  assert.equal(leanFromReturn(cove.outcome.return_20d_pct), "bearish");
  assert.equal(leanFromReturn(dune.outcome.return_5d_pct), "bearish");
  assert.equal(leanFromReturn(dune.outcome.return_20d_pct), "bearish");

  assert.ok(Math.abs(cove.outcome.return_5d_pct) <= DESK_EXPERIMENT_DEADBAND_PCT);
  assert.ok(drift.outcome.return_5d_pct < -DESK_EXPERIMENT_DEADBAND_PCT);
  assert.ok(bolt.outcome.return_5d_pct > DESK_EXPERIMENT_DEADBAND_PCT);
});

test("cases are deterministic across builds", () => {
  const a = buildDeskExperimentCases();
  const b = buildDeskExperimentCases();
  assert.deepEqual(
    a.map((row) => ({ id: row.id, as_of: row.snapshot.as_of, close: row.outcome.close_as_of })),
    b.map((row) => ({ id: row.id, as_of: row.snapshot.as_of, close: row.outcome.close_as_of })),
  );
});

test("parseLean and extractDeskVerdict read the closing JSON", () => {
  assert.equal(parseLean("Bullish"), "bullish");
  assert.equal(parseLean("short"), "bearish");
  assert.equal(parseLean("flat"), "neutral");
  const text = [
    "Overview: **fade** the bounce.",
    "```json",
    '{"lean_5d":"bearish","lean_20d":"bearish","confidence_5d":0.8,"confidence_20d":0.6,"thesis":"Distribution."}',
    "```",
  ].join("\n");
  const verdict = extractDeskVerdict(text);
  assert.equal(verdict?.lean_5d, "bearish");
  assert.equal(verdict?.thesis, "Distribution.");
  assert.ok(extractLastJsonObject("no json here") == null);
});

test("extractDeskVerdict takes the last object that has both leans, not the last brace", () => {
  const buried = [
    "scratch {not json",
    '{"note":"coil","bias":"long"}',
    "The tape is a spring.",
    '{"lean_5d":"bullish","lean_20d":"bullish","confidence_5d":0.6,"confidence_20d":0.5,"thesis":"Coil."}',
    "trailing {junk: true}",
  ].join("\n");
  const verdict = extractDeskVerdict(buried);
  assert.equal(verdict?.lean_5d, "bullish");
  assert.equal(verdict?.lean_20d, "bullish");
  assert.equal(verdict?.thesis, "Coil.");

  const incompleteFirst = [
    '{"lean_5d":"bullish"}',
    '{"lean_5d":"bearish","lean_20d":"neutral","confidence_5d":0.4,"confidence_20d":0.5,"thesis":"Event."}',
  ].join("\n");
  assert.equal(extractDeskVerdict(incompleteFirst)?.lean_5d, "bearish");
  assert.equal(extractDeskVerdict(incompleteFirst)?.lean_20d, "neutral");
});

test("verdict turns request kind=verdict; specialists stay prose", async () => {
  const cove = buildDeskExperimentCases().find((row) => row.id === "cove-event")!;
  const verdict = '{"lean_5d":"neutral","lean_20d":"bearish","confidence_5d":0.4,"confidence_20d":0.6,"thesis":"Event IV."}';
  const kinds: Array<string | undefined> = [];

  await runDeskApproach("solo", cove, async (req) => {
    kinds.push(req.kind);
    return { text: `Take.\n${verdict}`, latency_ms: 1 };
  });
  assert.deepEqual(kinds, ["verdict"]);

  kinds.length = 0;
  await runDeskApproach("desk_shared_session", cove, async (req) => {
    kinds.push(req.kind);
    return { text: req.kind === "verdict" ? `Weigh.\n${verdict}` : TAKE, latency_ms: 1 };
  });
  assert.deepEqual(kinds, ["prose", "prose", "prose", "prose", "verdict"]);

  kinds.length = 0;
  await runDeskApproach("desk_fresh_sessions", cove, async (req) => {
    kinds.push(req.kind);
    return { text: req.kind === "verdict" ? `Chair.\n${verdict}` : TAKE, latency_ms: 1 };
  });
  assert.deepEqual(kinds, ["prose", "prose", "prose", "prose", "verdict"]);

  kinds.length = 0;
  await runDeskApproach("desk_roleplay", cove, async (req) => {
    kinds.push(req.kind);
    return { text: verdict, latency_ms: 1 };
  });
  assert.deepEqual(kinds, ["verdict"]);
});

test("scoreDeskVerdict grades both horizons against held-out returns", () => {
  const drift = buildDeskExperimentCases().find((row) => row.id === "drift-breakdown")!;
  const hit = scoreDeskVerdict({
    lean_5d: "bearish",
    lean_20d: "bearish",
    confidence_5d: 0.7,
    confidence_20d: 0.7,
    thesis: "fade",
  }, drift);
  assert.equal(hit.correct, true);
  assert.equal(hit.signed_5d, 1);

  const miss = scoreDeskVerdict({
    lean_5d: "bullish",
    lean_20d: "bullish",
    confidence_5d: 0.9,
    confidence_20d: 0.9,
    thesis: "wrong",
  }, drift);
  assert.equal(miss.correct, false);
  assert.equal(miss.signed_5d, -1);
  assert.equal(signedLeanScore("neutral", "bearish"), 0);
});

const TAKE = "This is a grounded specialist take with levels, catalysts, and a clear lean from the snapshot evidence.";

test("solo uses one session; fresh sessions isolate specialists", async () => {
  const cove = buildDeskExperimentCases().find((row) => row.id === "cove-event")!;
  const verdict = '{"lean_5d":"neutral","lean_20d":"bearish","confidence_5d":0.4,"confidence_20d":0.6,"thesis":"Event IV, no spot edge."}';

  const solo = await runDeskApproach("solo", cove, async () => ({ text: `Take.\n${verdict}`, latency_ms: 2 }));
  assert.equal(solo.session_count, 1);
  assert.equal(solo.llm_calls, 1);
  assert.equal(solo.verdict?.lean_5d, "neutral");

  let calls = 0;
  const fresh = await runDeskApproach("desk_fresh_sessions", cove, async ({ messages }) => {
    calls += 1;
    const sys = messages.find((m) => m.role === "system")?.content ?? "";
    if (sys.includes("desk chair")) {
      return { text: `Overview weighing isolated takes.\n${verdict}`, latency_ms: 4 };
    }
    return { text: `${TAKE} isolated`, latency_ms: 2 };
  });
  assert.equal(fresh.session_count, 5);
  assert.equal(fresh.llm_calls, 5);
  assert.equal(calls, 5);
  const specialistSessions = fresh.sessions.filter((s) => s.specialist !== "chair");
  assert.equal(specialistSessions.length, 4);
  for (const session of specialistSessions) {
    const otherTakes = specialistSessions.filter((s) => s.id !== session.id).map((s) => s.text);
    const packed = session.messages.map((m) => m.content).join("\n");
    for (const other of otherTakes) {
      assert.equal(packed.includes(other), false, `${session.id} saw another specialist take`);
    }
    assert.match(packed, /AS OF /);
  }
});

test("shared session is one conversation; later seats see earlier takes", async () => {
  const bolt = buildDeskExperimentCases().find((row) => row.id === "bolt-coil")!;
  const verdict = '{"lean_5d":"bullish","lean_20d":"bullish","confidence_5d":0.6,"confidence_20d":0.5,"thesis":"Coil."}';
  let n = 0;
  const run = await runDeskApproach("desk_shared_session", bolt, async ({ messages }) => {
    n += 1;
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (lastUser.includes("desk chair")) return { text: `Weigh.\n${verdict}`, latency_ms: 2 };
    return { text: `${TAKE} turn=${n}`, latency_ms: 2 };
  });
  assert.equal(run.session_count, 1);
  assert.equal(run.llm_calls, 5);
  const chair = run.sessions.find((s) => s.id === "chair");
  assert.ok(chair);
  const history = chair!.messages.map((m) => m.content).join("\n");
  assert.match(history, /turn=1/);
  assert.match(history, /turn=4/);
});

test("role-play is one session and not a per-specialist agent", async () => {
  const dune = buildDeskExperimentCases().find((row) => row.id === "dune-duration")!;
  const payload = {
    fundamental: `${TAKE} rates beta, not an issuer.`,
    technical: `${TAKE} lower highs, duration leaking.`,
    options: `${TAKE} IV is quiet; the tape is yields.`,
    risk: `${TAKE} further auction tails break the bounce.`,
    overview: `${TAKE} fade duration.`,
    lean_5d: "bearish",
    lean_20d: "bearish",
    confidence_5d: 0.7,
    confidence_20d: 0.7,
    thesis: "Yields already rising into as-of.",
  };
  const run = await runDeskApproach("desk_roleplay", dune, async () => ({
    text: JSON.stringify(payload),
    latency_ms: 5,
  }));
  assert.equal(run.session_count, 1);
  assert.equal(run.llm_calls, 1);
  assert.equal(run.verdict?.lean_5d, "bearish");
  assert.ok(run.desk?.risk);
  const score = scoreDeskVerdict(run.verdict, dune);
  assert.equal(score.correct, true);
});

test("splitSystemMessages keeps system out of the OpenRouter messages array", () => {
  const split = splitSystemMessages([
    { role: "system", content: "You are the chair." },
    { role: "user", content: "snapshot" },
    { role: "assistant", content: "take" },
    { role: "user", content: "overview" },
  ]);
  assert.equal(split.system, "You are the chair.");
  assert.deepEqual(split.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.ok(!split.messages.some((m) => (m.role as string) === "system"));
});

test("deskCompletionText grades DeepSeek reasoning when visible text is empty", () => {
  assert.equal(deskCompletionText({ text: "", reasoningText: '{"lean_5d":"bearish"}' }), '{"lean_5d":"bearish"}');
  assert.equal(
    deskCompletionText({ text: "overview", reasoningText: '{"lean_5d":"bullish"}' }),
    'overview\n\n{"lean_5d":"bullish"}',
  );
  assert.equal(deskCompletionText({ text: "only" }), "only");
});

test("resolveDeskExperimentModel follows Chat COPILOT_MODEL", () => {
  assert.equal(
    resolveDeskExperimentModel({ COPILOT_MODEL: "deepseek/deepseek-v4-flash-0731" }),
    "deepseek/deepseek-v4-flash-0731",
  );
  assert.equal(
    resolveDeskExperimentModel({ COPILOT_MODEL: "deepseek/deepseek-v4-flash-0731" }, "openai/gpt-4o-mini"),
    "openai/gpt-4o-mini",
  );
  assert.equal(resolveDeskExperimentModel({}), "deepseek/deepseek-v4-flash-0731");
});

test("parseDeskExperimentProbeBody rejects unknown ids", () => {
  const bad = parseDeskExperimentProbeBody({ approach_id: "solo", case_id: "nope" });
  assert.equal(bad.ok, false);
  const ok = parseDeskExperimentProbeBody({
    approach_id: "desk_fresh_sessions",
    case_id: "drift-breakdown",
    model: "deepseek/deepseek-v4-flash-0731",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.approach_id, "desk_fresh_sessions");
    assert.equal(ok.case_id, "drift-breakdown");
    assert.equal(ok.model, "deepseek/deepseek-v4-flash-0731");
  }
});
