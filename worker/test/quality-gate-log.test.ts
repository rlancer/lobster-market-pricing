import assert from "node:assert/strict";
import test from "node:test";
import {
  listImprovementReports,
  listQualityGateEvents,
  parseQualityGateListQuery,
  recordQualityGateEvent,
  summarizeQualityGate,
  type QualityGateEvent,
} from "../src/quality-gate-log.ts";

function memoryDb() {
  const events: QualityGateEvent[] = [];
  const improvements: Array<Record<string, unknown>> = [];
  return {
    events,
    improvements,
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          if (sql.includes("INSERT INTO quality_gate_events")) {
            events.push({
              event_id: String(binds[0]),
              created_at: Number(binds[1]),
              action: String(binds[2]),
              allow: binds[3] == null ? null : Number(binds[3]) === 1,
              source: binds[4] == null ? null : String(binds[4]),
              reason: binds[5] == null ? null : String(binds[5]),
              share_id: binds[6] == null ? null : String(binds[6]),
              run_id: binds[7] == null ? null : String(binds[7]),
              bot_handle: binds[8] == null ? null : String(binds[8]),
              model: binds[9] == null ? null : String(binds[9]),
              extra: binds[10] ? JSON.parse(String(binds[10])) as Record<string, unknown> : null,
            });
          }
          return { success: true };
        },
        async first() {
          if (sql.includes("COUNT(*)")) {
            const since = Number(binds[0] ?? 0);
            const rows = events.filter((e) => e.created_at > since && e.action !== "remediator_sweep");
            return {
              decisions: rows.length,
              allowed: rows.filter((e) => e.allow === true).length,
              rejected: rows.filter((e) => e.allow === false).length,
              fail_open: rows.filter((e) => e.source === "fail_open").length,
              remediator_unlisted: rows.filter((e) =>
                e.action === "remoderate_unlist" || e.action === "read_unlist"
              ).length,
            };
          }
          if (sql.includes("action = 'remediator_sweep'")) {
            const sweep = [...events].reverse().find((e) => e.action === "remediator_sweep");
            return sweep
              ? { created_at: sweep.created_at, extra_json: JSON.stringify(sweep.extra) }
              : null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM quality_gate_events")) {
            let rows = [...events].sort((a, b) => b.created_at - a.created_at);
            if (sql.includes("action != 'remediator_sweep'")) {
              rows = rows.filter((e) => e.action !== "remediator_sweep");
            }
            let bindIdx = 0;
            if (sql.includes("action = ?")) {
              rows = rows.filter((e) => e.action === String(binds[bindIdx]));
              bindIdx += 1;
            }
            if (sql.includes("source = ?")) {
              rows = rows.filter((e) => e.source === String(binds[bindIdx]));
              bindIdx += 1;
            }
            const limit = Number(binds[binds.length - 1] ?? 50);
            return {
              results: rows.slice(0, limit).map((e) => ({
                ...e,
                allow: e.allow == null ? null : e.allow ? 1 : 0,
                extra_json: e.extra ? JSON.stringify(e.extra) : null,
              })),
            };
          }
          if (sql.includes("FROM improvement_reports")) {
            return { results: improvements };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  };
}

test("parseQualityGateListQuery caps limit and reads filters", () => {
  assert.deepEqual(
    parseQualityGateListQuery(new URL("https://api.lobster.mp/api/admin/quality-gate")),
    { limit: 50, action: null, source: null },
  );
  const filtered = parseQualityGateListQuery(
    new URL("https://api.lobster.mp/api/admin/quality-gate?limit=999&action=reject_bot_share&source=fail_open"),
  );
  assert.equal(filtered.limit, 100);
  assert.equal(filtered.action, "reject_bot_share");
  assert.equal(filtered.source, "fail_open");
});

test("recordQualityGateEvent + summarize counts fail-open and remediator unlists", async () => {
  const db = memoryDb();
  await recordQualityGateEvent(db as unknown as D1Database, {
    action: "allow_bot_share",
    decision: { allow: true, source: "llm", reason: "moderator allowed" },
    shareId: "goodShare",
    botHandle: "macrolobster",
  });
  await recordQualityGateEvent(db as unknown as D1Database, {
    action: "reject_bot_share",
    decision: { allow: false, source: "heuristic", reason: "assistant answer is unfinished tool-loop narration" },
    shareId: "1qKRZL7BSEpll6HDPoypuU8bS",
    botHandle: "macrolobster",
  });
  await recordQualityGateEvent(db as unknown as D1Database, {
    action: "allow_bot_share",
    decision: { allow: true, source: "fail_open", reason: "moderator unavailable" },
    shareId: "blipShare",
  });
  await recordQualityGateEvent(db as unknown as D1Database, {
    action: "remoderate_unlist",
    decision: { allow: false, source: "heuristic", reason: "assistant answer is unfinished tool-loop narration" },
    shareId: "1qKRZL7BSEpll6HDPoypuU8bS",
  });
  await recordQualityGateEvent(db as unknown as D1Database, {
    action: "remediator_sweep",
    extra: { scanned: 12, unlisted: 1 },
  });

  const summary = await summarizeQualityGate(db as unknown as D1Database);
  assert.equal(summary.decisions, 4);
  assert.equal(summary.allowed, 2);
  assert.equal(summary.rejected, 2);
  assert.equal(summary.fail_open, 1);
  assert.equal(summary.remediator_unlisted, 1);
  assert.ok(summary.last_sweep);
  assert.equal(summary.last_sweep?.scanned, 12);
  assert.equal(summary.last_sweep?.unlisted, 1);

  const rejects = await listQualityGateEvents(db as unknown as D1Database, {
    limit: 20,
    action: "reject_bot_share",
    source: null,
  });
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0]?.share_id, "1qKRZL7BSEpll6HDPoypuU8bS");

  const recent = await listQualityGateEvents(db as unknown as D1Database, {
    limit: 20,
    action: null,
    source: null,
  });
  assert.equal(recent.every((e) => e.action !== "remediator_sweep"), true);
});

test("listImprovementReports maps allow flags", async () => {
  const db = memoryDb();
  db.improvements.push({
    fingerprint: "assistant-answer-cutoff",
    title: "Prevent assistant answers from cutting off mid-thought",
    category: "truncation",
    issue_number: 300,
    issue_url: "https://github.com/rlancer/lobster-market-pricing/issues/300",
    share_id: "abc",
    bot_handle: "macrolobster",
    moderation_action: "reject_bot_share",
    moderation_allow: 0,
    created_at: 1,
  });
  const rows = await listImprovementReports(db as unknown as D1Database);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.moderation_allow, false);
  assert.equal(rows[0]?.fingerprint, "assistant-answer-cutoff");
});
