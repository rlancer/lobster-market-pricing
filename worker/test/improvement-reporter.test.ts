import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIssueBody,
  fallbackRejectSuggestion,
  IMPROVEMENT_LABEL,
  IMPROVEMENT_REVIEW_SYSTEM,
  normalizeFingerprint,
  parseImprovementSuggestions,
  scheduleImprovementReport,
  type ImprovementContext,
} from "../src/improvement-reporter.ts";

test("improvement review system asks for JSON improvements", () => {
  assert.match(IMPROVEMENT_REVIEW_SYSTEM, /fingerprint/);
  assert.match(IMPROVEMENT_REVIEW_SYSTEM, /empty improvements array/);
  assert.match(IMPROVEMENT_REVIEW_SYSTEM, /At most one improvement/);
});

test("normalizeFingerprint accepts kebab slugs", () => {
  assert.equal(normalizeFingerprint("cutoff-tool-loop"), "cutoff-tool-loop");
  assert.equal(normalizeFingerprint(" Cutoff Tool Loop "), "cutoff-tool-loop");
  assert.equal(normalizeFingerprint("a"), "a");
  assert.equal(normalizeFingerprint(""), null);
  assert.equal(normalizeFingerprint("!!!"), null);
  assert.equal(normalizeFingerprint(12), null);
});

test("parseImprovementSuggestions reads one sanitized item", () => {
  const parsed = parseImprovementSuggestions(`{
    "improvements": [{
      "fingerprint": "Seal Desk Before Cutoff!!",
      "title": "Seal desk overview before ending tool narration and never leave a mid-thought dump on the feed",
      "category": "truncation",
      "body": "Assistant ended mid 'Let me query…' without desk. Require a seal step."
    }, {
      "fingerprint": "second-should-be-ignored",
      "title": "Ignored",
      "category": "other",
      "body": "nope"
    }]
  }`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.fingerprint, "seal-desk-before-cutoff");
  assert.equal(parsed[0]?.category, "truncation");
  assert.ok((parsed[0]?.title.length ?? 0) <= 80);
  assert.match(parsed[0]?.body ?? "", /seal step/i);
});

test("parseImprovementSuggestions tolerates fences and empty arrays", () => {
  assert.deepEqual(parseImprovementSuggestions('```json\n{"improvements":[]}\n```'), []);
  assert.deepEqual(parseImprovementSuggestions("not json"), []);
  assert.deepEqual(parseImprovementSuggestions('{"improvements":[{"fingerprint":"x","title":"","body":"y"}]}'), []);
  const weird = parseImprovementSuggestions('{"improvements":[{"fingerprint":"ok-slug","title":"Fix it","category":"nope","body":"Do the thing."}]}');
  assert.equal(weird[0]?.category, "other");
});

test("buildIssueBody includes gate metadata and share link", () => {
  const body = buildIssueBody(
    {
      fingerprint: "cutoff-tool-loop",
      title: "Seal desk before cutoff",
      category: "truncation",
      body: "Require a finished desk seal.",
    },
    {
      messages: [],
      decision: { allow: false, reason: "unfinished tool-loop", source: "heuristic" },
      action: "reject_bot_share",
      shareId: "abc123",
      runId: "run-1",
      botHandle: "nowlobster",
      publicOrigin: "https://lobster.mp",
    },
  );
  assert.match(body, /Auto-filed/i);
  assert.match(body, /cutoff-tool-loop/);
  assert.match(body, /https:\/\/lobster\.mp\/share\/abc123/);
  assert.match(body, /@nowlobster/);
  assert.match(body, /reject_bot_share/);
  assert.equal(IMPROVEMENT_LABEL, "copilot-improvement");
});

test("scheduleImprovementReport no-ops without a GitHub token", () => {
  let scheduled = false;
  const ctx: ImprovementContext = {
    messages: [{ role: "user", content: "hi" }],
    decision: { allow: true, reason: "ok", source: "fail_open" },
    action: "allow_publish",
  };
  scheduleImprovementReport(
    { SCHEMA_DB: {} as D1Database },
    null,
    ctx,
    { waitUntil: () => { scheduled = true; } },
  );
  assert.equal(scheduled, false);
});

test("fallbackRejectSuggestion builds a stable fingerprint from the reason", () => {
  const fb = fallbackRejectSuggestion(
    { allow: false, reason: "assistant left only a reasoning placeholder — no finished answer", source: "heuristic" },
    "reject_bot_create_share",
  );
  assert.ok(fb);
  assert.match(fb!.fingerprint, /^reject-assistant-left-only/);
  assert.match(fb!.title, /reasoning placeholder/i);
  assert.equal(fb!.category, "truncation");
  assert.equal(fallbackRejectSuggestion({ allow: true, reason: "ok", source: "llm" }), null);
});
