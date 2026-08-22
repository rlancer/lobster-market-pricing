import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REPLY_STYLE,
  REPLY_NOTE_MAX,
  REPLY_STYLE_IDS,
  REPLY_STYLES,
  parseReplyNote,
  parseReplyPrefFromBody,
  parseReplyStyle,
  replyStyleAddon,
} from "../src/reply-style.ts";

test("reply style catalog is three canned audiences with tight prompts", () => {
  assert.deepEqual([...REPLY_STYLE_IDS], ["desk", "fund", "learner"]);
  for (const id of REPLY_STYLE_IDS) {
    const def = REPLY_STYLES[id];
    assert.ok(def.label.length > 0 && def.label.length <= 40);
    assert.ok(def.hint.length > 0 && def.hint.length <= 60);
    assert.ok(def.prompt.length >= 80 && def.prompt.length <= 420);
  }
});

test("parseReplyStyle defaults, lowercases, and rejects unknown ids", () => {
  assert.deepEqual(parseReplyStyle(null), { ok: true, value: DEFAULT_REPLY_STYLE });
  assert.deepEqual(parseReplyStyle(""), { ok: true, value: "desk" });
  assert.deepEqual(parseReplyStyle("FUND"), { ok: true, value: "fund" });
  assert.equal(parseReplyStyle("yolo").ok, false);
  assert.equal(parseReplyStyle(12).ok, false);
});

test("parseReplyNote clears blanks, rejects over-length, keeps a short note", () => {
  assert.deepEqual(parseReplyNote(null), { ok: true, value: null });
  assert.deepEqual(parseReplyNote("   "), { ok: true, value: null });
  assert.deepEqual(parseReplyNote("  I trade SPX 0DTE  "), { ok: true, value: "I trade SPX 0DTE" });
  assert.equal(parseReplyNote("x".repeat(REPLY_NOTE_MAX + 1)).ok, false);
  assert.equal(parseReplyNote("x".repeat(REPLY_NOTE_MAX)).ok, true);
  assert.equal(parseReplyNote(1).ok, false);
});

test("parseReplyPrefFromBody never fails a chat turn", () => {
  assert.deepEqual(parseReplyPrefFromBody(null), { style: "desk", note: null });
  assert.deepEqual(parseReplyPrefFromBody({ reply_style: "learner", reply_note: "  new to spreads  " }), {
    style: "learner",
    note: "new to spreads",
  });
  const clipped = parseReplyPrefFromBody({
    reply_style: "nope",
    reply_note: "n".repeat(REPLY_NOTE_MAX + 40),
  });
  assert.equal(clipped.style, "desk");
  assert.equal(clipped.note?.length, REPLY_NOTE_MAX);
});

test("replyStyleAddon is voice-only and stays under a tight budget", () => {
  const withNote = replyStyleAddon({ style: "fund", note: "I run a vol book." });
  assert.match(withNote, /hedge-fund/);
  assert.match(withNote, /I run a vol book/);
  assert.match(withNote, /never overrides SQL/);
  assert.ok(withNote.length < 900);
  const desk = replyStyleAddon({ style: "desk", note: null });
  assert.doesNotMatch(desk, /Reader note/);
  assert.ok(desk.length < 650);
});
