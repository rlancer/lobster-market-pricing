import assert from "node:assert/strict";
import test from "node:test";
import {
  asOfDateEt,
  dailyPnlFromMarks,
  upsertDailyMark,
  listPositionMarkHistory,
} from "../src/position-mark-history.ts";
import { snapOpenPositionMarks } from "../src/position-mark-snap.ts";

test("asOfDateEt uses America/New_York calendar day", () => {
  // 2026-08-23 03:00 UTC = still 2026-08-22 evening ET (EDT, UTC-4).
  assert.equal(asOfDateEt(Date.UTC(2026, 7, 23, 3, 0, 0)), "2026-08-22");
  // 2026-08-23 12:00 UTC = morning ET same calendar day.
  assert.equal(asOfDateEt(Date.UTC(2026, 7, 23, 12, 0, 0)), "2026-08-23");
});

test("dailyPnlFromMarks is day-over-day mark delta", () => {
  assert.deepEqual(
    dailyPnlFromMarks([{ mark_value: 100 }, { mark_value: 140 }, { mark_value: 120 }]),
    [null, 40, -20],
  );
  assert.deepEqual(dailyPnlFromMarks([{ mark_value: 50 }]), [null]);
});

type Stored = Record<string, unknown>;

function mockHistoryDb() {
  const rows = new Map<string, Stored>();
  const stmts: Array<{ sql: string; binds: unknown[] }> = [];

  const api = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          stmts.push({ sql, binds });
          if (sql.includes("INSERT INTO position_mark_history")) {
            const key = `${binds[1]}|${binds[2]}|${binds[3]}`;
            const existing = rows.get(key);
            const next: Stored = {
              id: existing?.id ?? binds[0],
              book: binds[1],
              position_id: binds[2],
              as_of_date: binds[3],
              marked_at: binds[4],
              source: binds[5],
              entry_value: binds[6],
              mark_value: binds[7],
              unrealized_pnl: binds[8],
              legs_json: binds[9] ?? existing?.legs_json ?? null,
              created_at: existing?.created_at ?? binds[4],
            };
            rows.set(key, next);
          }
          return { success: true };
        },
        async first<T>() {
          stmts.push({ sql, binds });
          if (sql.includes("FROM position_mark_history") && sql.includes("as_of_date")) {
            const key = `${binds[0]}|${binds[1]}|${binds[2]}`;
            return (rows.get(key) as T) ?? null;
          }
          return null;
        },
        async all<T>() {
          stmts.push({ sql, binds });
          if (sql.includes("FROM position_mark_history")) {
            const book = binds[0];
            const positionId = binds[1];
            const list = [...rows.values()]
              .filter((r) => r.book === book && r.position_id === positionId)
              .sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
            return { results: list as T[] };
          }
          if (sql.includes("FROM paper_positions") || sql.includes("FROM bot_trade_positions")) {
            return { results: [] as T[] };
          }
          return { results: [] as T[] };
        },
      };
      return stmt;
    },
  };

  return { db: api as unknown as D1Database, rows, stmts };
}

test("upsertDailyMark stores entry and overwrites same ET day", async () => {
  const { db, rows } = mockHistoryDb();
  const t0 = Date.UTC(2026, 7, 23, 14, 0, 0); // ET morning
  const first = await upsertDailyMark(db, {
    book: "paper",
    positionId: "pos_1",
    markValue: 100,
    entryValue: 100,
    markedAt: t0,
    source: "entry",
    legsJson: JSON.stringify([{ mid: 1 }]),
  });
  assert.equal(first.as_of_date, "2026-08-23");
  assert.equal(first.unrealized_pnl, 0);

  const later = await upsertDailyMark(db, {
    book: "paper",
    positionId: "pos_1",
    markValue: 150,
    entryValue: 100,
    markedAt: t0 + 3_600_000,
    source: "cron",
    legsJson: JSON.stringify([{ mid: 1.5 }]),
  });
  assert.equal(later.mark_value, 150);
  assert.equal(later.unrealized_pnl, 50);
  assert.equal(later.source, "cron");
  assert.equal(rows.size, 1);
});

test("listPositionMarkHistory attaches daily_pnl", async () => {
  const { db } = mockHistoryDb();
  const day1 = Date.UTC(2026, 7, 21, 18, 0, 0);
  const day2 = Date.UTC(2026, 7, 22, 18, 0, 0);
  await upsertDailyMark(db, {
    book: "bot",
    positionId: "bpos_1",
    markValue: 200,
    entryValue: 200,
    markedAt: day1,
    source: "entry",
  });
  await upsertDailyMark(db, {
    book: "bot",
    positionId: "bpos_1",
    markValue: 260,
    entryValue: 200,
    markedAt: day2,
    source: "cron",
  });
  const marks = await listPositionMarkHistory(db, "bot", "bpos_1");
  assert.equal(marks.length, 2);
  assert.equal(marks[0]!.daily_pnl, null);
  assert.equal(marks[1]!.daily_pnl, 60);
  assert.equal(marks[1]!.unrealized_pnl, 60);
});

test("snapOpenPositionMarks remakes open rows and writes history", async () => {
  const paperOpen = {
    id: "pos_open",
    ticker: "AAPL",
    qty: 1,
    legs_json: JSON.stringify([
      { instrument: "option", side: "buy", right: "call", strike: 200, expiration: "2026-09-18" },
    ]),
    entry_value: 100,
    entry_marked_at: 1,
  };

  const history = new Map<string, Stored>();
  const updates: Array<{ sql: string; binds: unknown[] }> = [];

  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          updates.push({ sql, binds });
          if (sql.includes("INSERT INTO position_mark_history")) {
            const key = `${binds[1]}|${binds[2]}|${binds[3]}`;
            history.set(key, {
              id: binds[0],
              book: binds[1],
              position_id: binds[2],
              as_of_date: binds[3],
              mark_value: binds[7],
              source: binds[5],
            });
          }
          return { success: true };
        },
        async first() {
          return null;
        },
        async all() {
          if (sql.includes("FROM paper_positions")) {
            return { results: [paperOpen] };
          }
          if (sql.includes("FROM bot_trade_positions")) {
            return { results: [] };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  const lake = async (sql: string) => {
    if (sql.includes("option_contracts")) {
      return [{ type: "call", strike: 200, expiration: "2026-09-18", bid: 1.4, ask: 1.6, last: 1.5 }];
    }
    return [];
  };

  const summary = await snapOpenPositionMarks(db, lake, {
    now: Date.UTC(2026, 7, 23, 18, 0, 0),
    limit: 10,
  });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.marked, 1);
  assert.equal(summary.paper_scanned, 1);
  assert.ok(updates.some((u) => u.sql.includes("UPDATE paper_positions")));
  assert.equal(history.size, 1);
  const snap = [...history.values()][0]!;
  assert.equal(snap.book, "paper");
  assert.equal(snap.source, "cron");
  // mid 1.5 × 100 = 150 structure value
  assert.equal(snap.mark_value, 150);
});
