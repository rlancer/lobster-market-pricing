import assert from "node:assert/strict";
import test from "node:test";
import {
  attachQaItem,
  createQaBatch,
  getQaBatch,
  importQaShares,
  listQaBatches,
  listQaItems,
  parseBotTriggerOptions,
  parseCreateQaBatch,
  parseQaVerdict,
  parseShareIds,
  patchQaItem,
} from "../src/qa-runs.ts";

test("parseBotTriggerOptions defaults to Floor listing", () => {
  assert.deepEqual(parseBotTriggerOptions({}), { listOnFloor: true, qaBatchId: null });
  assert.deepEqual(parseBotTriggerOptions(null), { listOnFloor: true, qaBatchId: null });
});

test("parseBotTriggerOptions treats a QA batch as off-Floor", () => {
  assert.deepEqual(parseBotTriggerOptions({ qa_batch_id: "abc" }), {
    listOnFloor: false,
    qaBatchId: "abc",
  });
  assert.deepEqual(parseBotTriggerOptions({ qa_batch_id: "abc", list_on_floor: false }), {
    listOnFloor: false,
    qaBatchId: "abc",
  });
  assert.deepEqual(parseBotTriggerOptions({ list_on_floor: false }), {
    listOnFloor: false,
    qaBatchId: null,
  });
});

test("parseBotTriggerOptions allows an explicit Floor override", () => {
  assert.deepEqual(parseBotTriggerOptions({ qa_batch_id: "abc", list_on_floor: true }), {
    listOnFloor: true,
    qaBatchId: "abc",
  });
});

test("parseCreateQaBatch requires a title and https PR URLs", () => {
  assert.equal(parseCreateQaBatch({}).ok, false);
  const ok = parseCreateQaBatch({
    title: "  Leak tape  ",
    description: "EWY on the public desk",
    pr_url: "https://github.com/rlancer/lobster-market-pricing/pull/328",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.title, "Leak tape");
    assert.equal(ok.value.pr_url?.endsWith("/328"), true);
  }
  assert.equal(parseCreateQaBatch({ title: "x", pr_url: "http://example.com" }).ok, false);
});

test("parseShareIds accepts ids, URLs, and whitespace lists", () => {
  const parsed = parseShareIds(
    "lk47GRwtI2RXDB2yTUNiD8Kn https://dev.lobster.mp/share/dOJQ1ZVU3trjvGLgbPptR4QZ\njoxc2j6kVxFjCiGnzlD4X3Mg",
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value, [
      "lk47GRwtI2RXDB2yTUNiD8Kn",
      "dOJQ1ZVU3trjvGLgbPptR4QZ",
      "joxc2j6kVxFjCiGnzlD4X3Mg",
    ]);
  }
});

test("parseQaVerdict accepts pass/fail plus a JSON payload", () => {
  const parsed = parseQaVerdict({ verdict_ok: true, verdict: { tape: true } });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.verdict_ok, true);
    assert.equal(parsed.value.verdict_json, JSON.stringify({ tape: true }));
  }
});

type ShareRow = {
  share_id: string;
  chat_id: string | null;
  run_id: string | null;
  bot_handle: string | null;
};

function qaMemoryDb(): D1Database & {
  batches: Map<string, Record<string, unknown>>;
  items: Map<string, Record<string, unknown>>;
  shares: Map<string, ShareRow>;
  cleared: string[];
} {
  const batches = new Map<string, Record<string, unknown>>();
  const items = new Map<string, Record<string, unknown>>();
  const shares = new Map<string, ShareRow>();
  const cleared: string[] = [];

  const db = {
    batches,
    items,
    shares,
    cleared,
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM qa_batches") && sql.includes("WHERE b.batch_id")) {
            const row = batches.get(String(binds[0]));
            if (!row) return null;
            const count = [...items.values()].filter((i) => i.batch_id === row.batch_id).length;
            return { ...row, item_count: count };
          }
          if (sql.includes("FROM qa_items WHERE share_id")) {
            return [...items.values()].find((i) => i.share_id === binds[0]) ?? null;
          }
          if (sql.includes("SELECT item_id FROM qa_items WHERE item_id")) {
            const row = items.get(String(binds[0]));
            return row ? { item_id: row.item_id } : null;
          }
          if (sql.includes("FROM qa_items i") && sql.includes("WHERE i.item_id")) {
            const row = items.get(String(binds[0]));
            if (!row) return null;
            const share = shares.get(String(row.share_id));
            return {
              ...row,
              listed_on_floor: share?.bot_handle ? 1 : 0,
            };
          }
          if (sql.includes("FROM shared_chats WHERE share_id")) {
            return shares.get(String(binds[0])) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM qa_batches")) {
            const results = [...batches.values()]
              .sort((a, b) => Number(b.created_at) - Number(a.created_at))
              .map((row) => ({
                ...row,
                item_count: [...items.values()].filter((i) => i.batch_id === row.batch_id).length,
              }));
            return { results };
          }
          if (sql.includes("FROM qa_items i")) {
            const batchId = String(binds[0]);
            const results = [...items.values()]
              .filter((i) => i.batch_id === batchId)
              .sort((a, b) => Number(b.created_at) - Number(a.created_at))
              .map((row) => {
                const share = shares.get(String(row.share_id));
                return { ...row, listed_on_floor: share?.bot_handle ? 1 : 0 };
              });
            return { results };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO qa_batches")) {
            batches.set(String(binds[0]), {
              batch_id: binds[0],
              title: binds[1],
              description: binds[2],
              pr_url: binds[3],
              created_at: binds[4],
            });
          }
          if (sql.includes("INSERT INTO qa_items")) {
            items.set(String(binds[0]), {
              item_id: binds[0],
              batch_id: binds[1],
              handle: binds[2],
              run_id: binds[3],
              share_id: binds[4],
              chat_id: binds[5],
              status: binds[6],
              verdict_ok: null,
              verdict_json: null,
              created_at: binds[7],
            });
          }
          if (sql.includes("UPDATE qa_items")) {
            const row = items.get(String(binds[0]));
            if (row) {
              if (binds[1] != null) row.verdict_ok = binds[1];
              if (binds[2] != null) row.verdict_json = binds[2];
            }
          }
          if (sql.includes("UPDATE shared_chats SET bot_handle = NULL")) {
            const share = shares.get(String(binds[0]));
            if (share?.bot_handle) {
              share.bot_handle = null;
              cleared.push(String(binds[0]));
            }
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & typeof db;
}

test("createQaBatch and attachQaItem persist a ledger row", async () => {
  const db = qaMemoryDb();
  const batch = await createQaBatch(db, {
    title: "Leak tape",
    description: "EWY must not lead the public desk",
    pr_url: "https://github.com/rlancer/lobster-market-pricing/pull/328",
  }, 1_700_000_000_000);
  assert.equal(batch.title, "Leak tape");
  assert.equal((await getQaBatch(db, batch.batch_id))?.item_count, 0);

  const item = await attachQaItem(db, {
    batch_id: batch.batch_id,
    handle: "nowlobster",
    run_id: "run-1",
    share_id: "shareAAA",
    chat_id: "chat-1",
  }, 1_700_000_000_100);
  assert.equal(item.share_id, "shareAAA");
  assert.equal(item.listed_on_floor, false);

  const again = await attachQaItem(db, {
    batch_id: batch.batch_id,
    share_id: "shareAAA",
  });
  assert.equal(again.item_id, item.item_id);
  assert.equal((await listQaBatches(db))[0]?.item_count, 1);
  assert.equal((await listQaItems(db, batch.batch_id)).length, 1);
});

test("importQaShares unlists Floor posts and records the batch", async () => {
  const db = qaMemoryDb();
  const batch = await createQaBatch(db, {
    title: "Backfill leak e2e",
    description: "Three live overview shares",
    pr_url: "https://github.com/rlancer/lobster-market-pricing/pull/328",
  });
  db.shares.set("listed1", {
    share_id: "listed1",
    chat_id: "c1",
    run_id: "r1",
    bot_handle: "nowlobster",
  });
  db.shares.set("alreadyOff", {
    share_id: "alreadyOff",
    chat_id: "c2",
    run_id: "r2",
    bot_handle: null,
  });

  const imported = await importQaShares(db, batch.batch_id, ["listed1", "alreadyOff", "missing"]);
  assert.deepEqual(imported.missing, ["missing"]);
  assert.equal(imported.items.length, 2);
  assert.equal(db.shares.get("listed1")?.bot_handle, null);
  assert.ok(db.cleared.includes("listed1"));
  assert.equal(imported.items.every((item) => item.listed_on_floor === false), true);
});

test("patchQaItem records a pass verdict", async () => {
  const db = qaMemoryDb();
  const batch = await createQaBatch(db, { title: "Tape", description: null, pr_url: null });
  db.shares.set("s1", { share_id: "s1", chat_id: "c", run_id: "r", bot_handle: null });
  const item = await attachQaItem(db, { batch_id: batch.batch_id, share_id: "s1" });
  const patched = await patchQaItem(db, item.item_id, {
    verdict_ok: true,
    verdict_json: JSON.stringify({ tape: true }),
  });
  assert.equal(patched?.verdict_ok, true);
  assert.deepEqual(patched?.verdict_json, { tape: true });
});
