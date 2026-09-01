import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanEl5Text,
  formatEl5Source,
  getOrComputeEl5,
  hashEl5Source,
  lookupEl5,
  resolveEl5Cache,
  type El5CachedRow,
  type El5ShareRecord,
  type El5Store,
} from "../src/el5.ts";

function memoryStore(share: El5ShareRecord | null): El5Store & { rows: Map<string, El5CachedRow> } {
  const rows = new Map<string, El5CachedRow>();
  return {
    rows,
    readShare: async () => share,
    readTranslation: async (id) => rows.get(id) ?? null,
    writeTranslation: async (id, row) => {
      rows.set(id, row);
    },
  };
}

test("formatEl5Source keeps title, turns, desk, and trades", () => {
  const text = formatEl5Source(
    [
      { role: "user", content: "  What about NVDA IV?  " },
      {
        role: "assistant",
        content: "IV is elevated.",
        desk: { overview: "Vol is rich vs RV30.", options: "Call skew is bid." },
        trades: {
          trades: [{ ticker: "NVDA", bias: "bearish", structure: "put debit", rationale: "Fade the pop." }],
        },
      },
      { role: "system", content: "ignore" },
    ],
    "NVDA vol crush",
  );
  assert.match(text, /^title: NVDA vol crush/);
  assert.match(text, /user: What about NVDA IV\?/);
  assert.match(text, /assistant: IV is elevated\./);
  assert.match(text, /desk overview: Vol is rich vs RV30\./);
  assert.match(text, /desk options: Call skew is bid\./);
  assert.match(text, /trade: NVDA — bearish — put debit — Fade the pop\./);
  assert.doesNotMatch(text, /system:/);
});

test("formatEl5Source clips from the tail when over budget", () => {
  const text = formatEl5Source(
    [{ role: "assistant", content: "abcdefghij" }],
    null,
    8,
  );
  assert.equal(text, "cdefghij");
});

test("hashEl5Source is stable SHA-256 hex", async () => {
  const a = await hashEl5Source("hello");
  const b = await hashEl5Source("hello");
  const c = await hashEl5Source("hello!");
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(a, c);
});

test("resolveEl5Cache hits only on matching hash", () => {
  const cached: El5CachedRow = {
    source_hash: "abc",
    el5_text: "The stock went up like a balloon.",
    computed_at: 1,
    model: "x",
  };
  const hit = resolveEl5Cache("s1", cached, "abc", false);
  assert.equal(hit?.cache_hit, true);
  assert.equal(hit?.el5, cached.el5_text);
  assert.equal(resolveEl5Cache("s1", cached, "zzz", false), null);
  assert.equal(resolveEl5Cache("s1", cached, "abc", true), null);
  assert.equal(resolveEl5Cache("s1", null, "abc", false), null);
});

test("cleanEl5Text strips fences", () => {
  assert.equal(cleanEl5Text("```markdown\nHello IV is jumpiness.\n```"), "Hello IV is jumpiness.");
});

test("lookupEl5 404s unknown or expired shares", async () => {
  await assert.rejects(
    () => lookupEl5("nope", memoryStore(null)),
    (err: Error & { status?: number }) => err.status === 404,
  );
  const expired = memoryStore({
    title: "x",
    messages: [{ role: "assistant", content: "hi there friend this is long enough" }],
    expires_at: 1,
  });
  await assert.rejects(
    () => lookupEl5("ShareId0001", expired, { now: () => 100 }),
    (err: Error & { status?: number }) => err.status === 404,
  );
});

test("getOrComputeEl5 serves a matching cache without calling the model", async () => {
  const store = memoryStore({
    title: "NVDA",
    messages: [{ role: "assistant", content: "Implied vol is high — the crowd expects big swings." }],
    expires_at: null,
  });
  const looked = await lookupEl5("ShareId0001", store);
  assert.equal(looked.hit, null);
  await store.writeTranslation("ShareId0001", {
    source_hash: looked.sourceHash,
    el5_text: "The crowd thinks the price will jump around a lot.",
    computed_at: 7,
    model: "test-model",
  });
  const hit = await getOrComputeEl5("ShareId0001", {
    store,
    modelName: "test-model",
    createModel: () => {
      throw new Error("must not generate on cache hit");
    },
  });
  assert.equal(hit.cache_hit, true);
  assert.equal(hit.el5, "The crowd thinks the price will jump around a lot.");
});
