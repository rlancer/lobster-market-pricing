import { describe, expect, it, vi, afterEach } from "vitest";
import { EtlScheduler, type JobSpec, type JobStateRow, type SchedulerEnv } from "./scheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

type Row = Record<string, unknown>;

interface SchedulerTestStorage {
  get(k: string): Promise<unknown>;
  put(k: string, v: unknown): Promise<void>;
  delete(k: string): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(v: number): Promise<void>;
}

interface TestCtx {
  storage: SchedulerTestStorage;
}

// ---------------------------------------------------------------------------
// In-memory D1 fake modeling job_state / symbol_state / loader_meta, handling
// the specific statements the scheduler issues. Lets the tests assert seed,
// due-scan, backoff, and per-job market gating end to end.
// ---------------------------------------------------------------------------
class FakeDb {
  jobState = new Map<string, Row>();
  symbolState = new Map<string, Row>();
  meta = new Map<string, string>();
  dueJobLimit = 20;

  prepare(sql: string) {
    let args: unknown[] = [];
    const bound = {
      bind: (...a: unknown[]) => {
        args = a;
        return bound;
      },
      first: () => this.first(sql, args),
      all: () => this.all(sql, args),
      run: () => this.run(sql, args),
    };
    return bound;
  }

  private first(sql: string, args: unknown[]): Row | null {
    if (sql.includes("COUNT(*) AS c FROM symbol_state")) {
      return { c: this.symbolState.size };
    }
    if (sql.includes("FROM symbol_state WHERE symbol = ?")) {
      return this.symbolState.get(String(args[0])) ?? null;
    }
    if (sql.includes("FROM job_state WHERE job_id = ?")) {
      return this.jobState.get(String(args[0])) ?? null;
    }
    if (
      sql.includes("FROM job_state") &&
      sql.includes("market_gated = 0") &&
      sql.includes("ORDER BY next_attempt_after ASC")
    ) {
      const rows = [...this.jobState.values()]
        .filter((r) => r.enabled === 1 && Number(r.market_gated) === 0)
        .sort((a, b) => Number(a.next_attempt_after) - Number(b.next_attempt_after));
      return rows[0] ? { next_attempt_after: rows[0].next_attempt_after } : null;
    }
    if (sql.includes("SELECT value FROM loader_meta")) {
      return { value: this.meta.get(String(args[0])) ?? null };
    }
    return null;
  }

  private all(sql: string, args: unknown[]): { results: Row[]; success: boolean } {
    const fromTable = /FROM\s+(\w+)/.exec(sql)?.[1];
    if (fromTable && sql.includes("enabled = 1 AND next_attempt_after")) {
      const now = Number(args[0]);
      if (fromTable === "symbol_state") {
        const rows = [...this.symbolState.values()]
          .filter((r) => r.enabled === 1 && Number(r.next_attempt_after) <= now)
          .sort((a, b) => {
            const aP = Number(a.priority ?? 0), bP = Number(b.priority ?? 0);
            if (aP !== bP) return aP - bP;
            const aS = a.last_success_at == null ? -1 : Number(a.last_success_at);
            const bS = b.last_success_at == null ? -1 : Number(b.last_success_at);
            return aS - bS;
          });
        return {
          results: rows.slice(0, Number(args[1])).map((r) => ({ symbol: r.symbol })),
          success: true,
        };
      }
      if (fromTable === "job_state") {
        const limit = Number(args[1]) || this.dueJobLimit;
        const rows = [...this.jobState.values()]
          .filter((r) => r.enabled === 1 && Number(r.next_attempt_after) <= now)
          .sort((a, b) => {
            const aS = a.last_success_at == null ? -1 : Number(a.last_success_at);
            const bS = b.last_success_at == null ? -1 : Number(b.last_success_at);
            return aS - bS;
          })
          .slice(0, limit)
          .map((r) => ({ ...r }));
        return { results: rows, success: true };
      }
    }
    if (fromTable === "job_state") {
      // Plain read (jobRows: ORDER BY job_id) — return every ledger row.
      return { results: [...this.jobState.values()].map((r) => ({ ...r })), success: true };
    }
    return { results: [], success: true };
  }

  private run(sql: string, args: unknown[]): { success: boolean } {
    if (sql.startsWith("INSERT OR IGNORE INTO job_state")) {
      // VALUES (?, ?, 1, ?, ?, 0, NULL, 0, ?, NULL) — enabled/next/consec are
      // literal; only [jobId, handler, cadence, marketGated, backoff] are bound.
      const [jobId, handler, cadence, marketGated, backoff] = args;
      if (!this.jobState.has(String(jobId))) {
        this.jobState.set(String(jobId), {
          job_id: jobId, handler, enabled: 1, cadence_seconds: cadence, market_gated: marketGated,
          next_attempt_after: 0, last_success_at: null, consecutive_failures: 0,
          backoff_seconds: backoff, last_error: null,
        });
      }
      return { success: true };
    }
    if (sql.startsWith("UPDATE job_state")) {
      const row = this.jobState.get(String(args[args.length - 1]));
      if (sql.includes("consecutive_failures = ?")) {
        // failure branch: [consecutive, backoff, next, last_error, jobId]
        if (row) {
          row.consecutive_failures = args[0];
          row.backoff_seconds = args[1];
          row.next_attempt_after = args[2];
          row.last_error = args[3];
        }
      } else {
        // success branch: [now, base, next, jobId]
        if (row) {
          row.last_success_at = args[0];
          row.consecutive_failures = 0;
          row.backoff_seconds = args[1];
          row.next_attempt_after = args[2];
          row.last_error = null;
        }
      }
      return { success: true };
    }
    if (sql.startsWith("INSERT OR IGNORE INTO symbol_state")) {
      const symbol = String(args[0]);
      if (!this.symbolState.has(symbol)) {
        const [id, enabled, lsa, lat, cf, nta, backoff, lastErr, priority] = args;
        this.symbolState.set(symbol, {
          symbol: id, enabled, last_success_at: lsa, last_attempt_at: lat,
          consecutive_failures: cf, next_attempt_after: nta, backoff_seconds: backoff,
          last_error: lastErr, priority,
        });
      }
      return { success: true };
    }
    if (sql.startsWith("UPDATE symbol_state")) {
      if (sql.includes("SET last_attempt_at")) {
        const now = args[0];
        for (const s of args.slice(1)) {
          const row = this.symbolState.get(String(s));
          if (row) row.last_attempt_at = now;
        }
        return { success: true };
      }
      if (sql.includes("SET consecutive_failures = ?")) {
        const [consec, backoff, next, lastError, id] = args;
        const row = this.symbolState.get(String(id));
        if (row) {
          row.consecutive_failures = consec;
          row.backoff_seconds = backoff;
          row.next_attempt_after = next;
          row.last_error = lastError;
        }
        return { success: true };
      }
      // success branch
      const [now, base, next, id] = args;
      const row = this.symbolState.get(String(id));
      if (row) {
        row.last_success_at = now;
        row.consecutive_failures = 0;
        row.backoff_seconds = base;
        row.next_attempt_after = next;
        row.last_error = null;
      }
      return { success: true };
    }
    if (sql.includes("INSERT INTO loader_meta")) {
      this.meta.set(String(args[0]), String(args[1]));
      return { success: true };
    }
    return { success: true };
  }
}

type Ctx = { storage: Record<string, unknown> };

function makeStorage(initial: Record<string, unknown> = {}): SchedulerTestStorage {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    async get(k: string) { return store.get(k) ?? null; },
    async put(k: string, v: unknown) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
    async getAlarm() { return (store.get("__alarm__") as number | null) ?? null; },
    async setAlarm(v: number) { store.set("__alarm__", v); },
  };
}

function ctx(storage: SchedulerTestStorage): TestCtx {
  return { storage };
}

function env(db: unknown, overrides: Record<string, unknown> = {}): SchedulerEnv {
  return {
    LOADER_DB: db,
    MARKET_HOURS_ENABLED: "false", // bypass market gating unless a test overrides
    LOADER_BATCH_SIZE: 10,
    LOADER_BACKOFF_BASE_SECONDS: 60,
    LOADER_BACKOFF_CAP_SECONDS: 1800,
    LOADER_CADENCE_SECONDS: 900,
    LOADER_POLL_INTERVAL_SECONDS: 60,
    ...overrides,
  };
}

function rowFrom(partial: Partial<JobStateRow>): JobStateRow {
  return {
    job_id: "j",
    handler: "j",
    enabled: 1,
    cadence_seconds: 900,
    market_gated: 0,
    next_attempt_after: 0,
    last_success_at: null,
    consecutive_failures: 0,
    backoff_seconds: 60,
    last_error: null,
    ...partial,
  };
}

describe("EtlScheduler — job-state seed", () => {
  it("seedJobs writes a cboe-options row with policy defaults", async () => {
    const db = new FakeDb();
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    await scheduler.seedJobs();

    const row = db.jobState.get("cboe-options");
    expect(row).toBeTruthy();
    expect(row?.handler).toBe("cboe-options");
    expect(row?.enabled).toBe(1);
    expect(row?.market_gated).toBe(1);
    expect(row?.cadence_seconds).toBe(900);
    expect(row?.next_attempt_after).toBe(0);
    expect(row?.consecutive_failures).toBe(0);
    expect(row?.backoff_seconds).toBe(60);

    // ohlc-daily is seeded too: ungated, daily cadence.
    const ohlc = db.jobState.get("ohlc-daily");
    expect(ohlc).toBeTruthy();
    expect(ohlc?.enabled).toBe(1);
    expect(ohlc?.market_gated).toBe(0);
    expect(ohlc?.cadence_seconds).toBe(86400);
  });

  it("seedJobs is idempotent — repeated calls don't clobber progress", async () => {
    const db = new FakeDb();
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    await scheduler.seedJobs();
    // Simulate a persisted last_success_at.
    db.jobState.get("cboe-options")!.last_success_at = 12345;
    await scheduler.seedJobs();
    expect(db.jobState.get("cboe-options")!.last_success_at).toBe(12345);
  });
});

describe("EtlScheduler — due-scan", () => {
  it("returns only enabled, due jobs, ordered stalest-first", async () => {
    const db = new FakeDb();
    const now = 1000;
    db.jobState.set("a", { ...rowFrom({ job_id: "a", handler: "a", enabled: 1, next_attempt_after: 100, last_success_at: 500 }) });
    db.jobState.set("b", { ...rowFrom({ job_id: "b", handler: "b", enabled: 1, next_attempt_after: 200, last_success_at: 900 }) });
    db.jobState.set("c", { ...rowFrom({ job_id: "c", handler: "c", enabled: 1, next_attempt_after: now + 1, last_success_at: 300 }) }); // not due
    db.jobState.set("d", { ...rowFrom({ job_id: "d", handler: "d", enabled: 0, next_attempt_after: 50, last_success_at: 100 }) }); // disabled

    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    const due = await scheduler.dueJobs(now);

    expect(due.map((r) => r.job_id)).toEqual(["a", "b"]);
  });

  it("bootstrap fallback treats configured jobs as due when ledger is empty", async () => {
    const db = new FakeDb();
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    const due = await scheduler.dueJobs(Date.now());
    expect(due.map((r) => r.job_id)).toEqual([
      "cboe-options", "ohlc-daily", "ohlc-backfill", "earnings-daily", "fred-econ-daily", "etf-daily",
      "fundamentals-daily", "futures-ohlc-daily", "cfe-futures-daily", "indices-ohlc-daily",
      "crypto-spot-ohlc-daily", "research-briefs-daily", "sec-filings-daily",
    ]);
  });
});

describe("EtlScheduler — backoff tiers", () => {
  it("walks 60s → 5m → 30m capped by consecutive failures", async () => {
    const db = new FakeDb();
    db.symbolState.set("NEW", { ...rowFrom({ job_id: "x", consecutive_failures: 0 }) });
    db.symbolState.set("AGAIN", { ...rowFrom({ job_id: "x", consecutive_failures: 1 }) });
    db.symbolState.set("MANY", { ...rowFrom({ job_id: "x", consecutive_failures: 5 }) });

    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    const batch = ["NEW", "AGAIN", "MANY"];
    await scheduler.applyResults(batch, [], new Map(), 0, 60, 1800, 900, null);

    // First failure → 60s; second consecutive → 300s; ≥third → capped at 1800s.
    expect(db.symbolState.get("NEW")!.backoff_seconds).toBe(60);
    expect(db.symbolState.get("NEW")!.consecutive_failures).toBe(1);
    expect(db.symbolState.get("AGAIN")!.backoff_seconds).toBe(300);
    expect(db.symbolState.get("AGAIN")!.consecutive_failures).toBe(2);
    expect(db.symbolState.get("MANY")!.backoff_seconds).toBe(1800);
    expect(db.symbolState.get("MANY")!.consecutive_failures).toBe(6);
  });

  it("on success resets failures and re-schedules at the cadence", async () => {
    const db = new FakeDb();
    db.symbolState.set("OK", { ...rowFrom({ job_id: "x", consecutive_failures: 3, backoff_seconds: 1800, next_attempt_after: 5, last_error: "boom" }) });
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    await scheduler.applyResults(["OK"], ["OK"], new Map(), 1000, 60, 1800, 900, null);

    const row = db.symbolState.get("OK")!;
    expect(row.consecutive_failures).toBe(0);
    expect(row.backoff_seconds).toBe(60);
    expect(row.next_attempt_after).toBe(1000 + 900 * 1000);
    expect(row.last_error).toBeNull();
    expect(row.last_success_at).toBe(1000);
  });
});

describe("EtlScheduler — single-flight", () => {
  it("skips the pass while a live `passing` marker is present", async () => {
    const db = new FakeDb();
    const s = makeStorage({ passing: Date.now() });
    const scheduler = new EtlScheduler(ctx(s), env(db) as never);
    await scheduler.tick();
    // Live marker: tick returned without clearing it.
    expect(await s.get("passing")).toBeTruthy();
  });

  it("self-heals a stale `passing` marker", async () => {
    const db = new FakeDb();
    const s = makeStorage({ passing: true }); // legacy boolean => stale
    const scheduler = new EtlScheduler(ctx(s), env(db) as never);
    await scheduler.tick();
    expect(await s.get("passing")).toBeNull();
  });
});

describe("EtlScheduler — job observability routes", () => {
  it("/jobs lists all registered jobs with scope + policy", async () => {
    const db = new FakeDb();
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    const list = await scheduler.jobsList();

    expect(list.jobs).toHaveLength(13);
    const byId = new Map((list.jobs as Row[]).map((j) => [j.job_id, j]));
    const cboe = byId.get("cboe-options")!;
    expect(cboe.scope).toBe("items");
    expect(cboe.enabled).toBe(1);
    expect(cboe.market_gated).toBe(1);
    const ohlc = byId.get("ohlc-daily")!;
    expect(ohlc.scope).toBe("batch");
    expect(ohlc.enabled).toBe(1);
    expect(ohlc.market_gated).toBe(0);
    expect(ohlc.cadence_seconds).toBe(86400);
    expect(ohlc.last_pass).toBeNull();
    const backfill = byId.get("ohlc-backfill")!;
    expect(backfill.scope).toBe("items");
    expect(backfill.enabled).toBe(1);
    expect(backfill.market_gated).toBe(0);
    const earnings = byId.get("earnings-daily")!;
    expect(earnings.scope).toBe("batch");
    expect(earnings.enabled).toBe(1);
    expect(earnings.market_gated).toBe(0);
    expect(earnings.cadence_seconds).toBe(86400);
    const econ = byId.get("fred-econ-daily")!;
    expect(econ.scope).toBe("batch");
    expect(econ.enabled).toBe(1);
    expect(econ.market_gated).toBe(0);
    expect(econ.cadence_seconds).toBe(86400);
    const etf = byId.get("etf-daily")!;
    expect(etf.scope).toBe("batch");
    expect(etf.enabled).toBe(1);
    expect(etf.market_gated).toBe(0);
    expect(etf.cadence_seconds).toBe(86400);
    const fundamentals = byId.get("fundamentals-daily")!;
    expect(fundamentals.scope).toBe("batch");
    expect(fundamentals.enabled).toBe(1);
    expect(fundamentals.market_gated).toBe(0);
    expect(fundamentals.cadence_seconds).toBe(86400);
    const futuresOhlc = byId.get("futures-ohlc-daily")!;
    expect(futuresOhlc.scope).toBe("batch");
    expect(futuresOhlc.enabled).toBe(1);
    expect(futuresOhlc.market_gated).toBe(0);
    expect(futuresOhlc.cadence_seconds).toBe(86400);
    const cfe = byId.get("cfe-futures-daily")!;
    expect(cfe.scope).toBe("batch");
    expect(cfe.enabled).toBe(1);
    expect(cfe.market_gated).toBe(0);
    expect(cfe.cadence_seconds).toBe(86400);
    const indices = byId.get("indices-ohlc-daily")!;
    expect(indices.scope).toBe("batch");
    expect(indices.enabled).toBe(1);
    expect(indices.market_gated).toBe(0);
    expect(indices.cadence_seconds).toBe(86400);
    const cryptoSpot = byId.get("crypto-spot-ohlc-daily")!;
    expect(cryptoSpot.scope).toBe("batch");
    expect(cryptoSpot.enabled).toBe(1);
    expect(cryptoSpot.market_gated).toBe(0);
    expect(cryptoSpot.cadence_seconds).toBe(86400);
    const research = byId.get("research-briefs-daily")!;
    expect(research.scope).toBe("items");
    expect(research.enabled).toBe(1);
    expect(research.market_gated).toBe(0);
    expect(research.cadence_seconds).toBe(86400);
    const secFilings = byId.get("sec-filings-daily")!;
    expect(secFilings.scope).toBe("batch");
    expect(secFilings.enabled).toBe(1);
    expect(secFilings.market_gated).toBe(0);
    expect(secFilings.cadence_seconds).toBe(86400);
  });

  it("unknown job returns an error; trigger returns 404", async () => {
    const db = new FakeDb();
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    const status = await scheduler.jobStatus("nope");
    expect(status.ok).toBe(false);

    const res = await scheduler.fetch(new Request("http://x/jobs/nope/trigger"));
    expect(res.status).toBe(404);
  });

  it("/jobs/{id}/trigger kicks a batch job pass (ohlc dry-runs cheaply)", async () => {
    const db = new FakeDb();
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    const res = await scheduler.fetch(new Request("http://x/jobs/ohlc-daily/trigger"));
    expect(res.status).toBe(200);

    // The dry-run pass recorded a last_pass for the job with no failures.
    const pass = JSON.parse(db.meta.get("last_pass:ohlc-daily") ?? "{}");
    expect(pass.attempted).toBeGreaterThan(0);
    expect(pass.failed).toBe(0);
    const row = db.jobState.get("ohlc-daily")!;
    expect(Number(row.last_success_at)).toBeGreaterThan(0);
  });
});

describe("EtlScheduler — batch-scoped jobs", () => {
  it("runs the whole universe and reports per-item failures (no item store)", async () => {
    const db = new FakeDb();
    db.jobState.set("batchjob", {
      ...rowFrom({ job_id: "batchjob", handler: "batchjob", market_gated: 0, cadence_seconds: 86400 }),
    });
    const rec = { ranItems: [] as string[] };
    const spec: JobSpec = {
      id: "batchjob",
      marketGated: false,
      cadenceSeconds: 86400,
      scope: "batch",
      universe: () => ["A1", "B2", "C3"],
      run: async (items) => {
        rec.ranItems = items;
        return { runId: "r1", failures: [{ symbol: "B2", error: "boom" }] };
      },
    };
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    const row = rowFrom({ job_id: "batchjob", handler: "batchjob", market_gated: 0, cadence_seconds: 86400 });
    await scheduler.runJobPass(spec, row, 600000);

    expect(rec.ranItems).toEqual(["A1", "B2", "C3"]);
    const pass = JSON.parse(db.meta.get("last_pass:batchjob") ?? "{}");
    expect(pass.attempted).toBe(3);
    expect(pass.succeeded).toBe(2);
    expect(pass.failed).toBe(1);
    // Batch jobs touch no item store.
    expect(db.symbolState.size).toBe(0);
    // Scheduled at the daily cadence, not the poll interval.
    const jobRow = db.jobState.get("batchjob")!;
    expect(Number(jobRow.last_success_at)).toBeGreaterThan(0);
    expect(Number(jobRow.next_attempt_after)).toBeGreaterThanOrEqual(Date.now() + 86400000 - 60_000);
  });
});

describe("EtlScheduler — per-job market_gated", () => {
  function recordingSpec(): { spec: JobSpec; rec: { seeded: boolean; ran: boolean } } {
    const rec = { seeded: false, ran: false };
    const spec: JobSpec = {
      id: "t",
      marketGated: true,
      cadenceSeconds: 900,
      scope: "items",
      itemTable: "symbol_state",
      itemIdColumn: "symbol",
      seedItems: async () => {
        rec.seeded = true;
      },
      run: async () => {
        rec.ran = true;
        return { runId: null, failures: [] };
      },
    };
    return { spec, rec };
  }

  it("skips a market_gated job while the US session is closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-04T12:00:00Z")); // Sunday — market closed
    const db = new FakeDb();
    const { spec, rec } = recordingSpec();
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db, { MARKET_HOURS_ENABLED: "true" }) as never);

    const row = rowFrom({ job_id: "t", handler: "t", market_gated: 1 });
    await scheduler.runJobPass(spec, row, 600000);

    expect(rec.seeded).toBe(false);
    expect(rec.ran).toBe(false);
  });

  it("does NOT gate a job with market_gated=0 (runs while market closed)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-04T12:00:00Z")); // Sunday — market closed
    const db = new FakeDb();
    const { spec, rec } = recordingSpec();
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db, { MARKET_HOURS_ENABLED: "true" }) as never);

    const row = rowFrom({ job_id: "t", handler: "t", market_gated: 0 });
    await scheduler.runJobPass(spec, row, 600000);

    // Pass proceeds past the market gate: item store was seeded, then the due
    // scan on the (empty) store yields nothing, so run() is not reached.
    expect(rec.seeded).toBe(true);
    expect(rec.ran).toBe(false);
  });

  it("force trigger (?force=1) runs a market_gated job while the market is closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-04T12:00:00Z")); // Sunday — market closed
    const db = new FakeDb();
    const rec = { seeded: false, ran: false };
    const spec: JobSpec = {
      id: "forcet",
      marketGated: true,
      cadenceSeconds: 900,
      scope: "items",
      itemTable: "symbol_state",
      itemIdColumn: "symbol",
      seedItems: async (database) => {
        rec.seeded = true;
        await database.prepare(
          `INSERT OR IGNORE INTO symbol_state
             (symbol, enabled, last_success_at, last_attempt_at, consecutive_failures,
              next_attempt_after, backoff_seconds, last_error, priority)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind("X", 1, null, null, 0, 1, 60, null, 0).run();
      },
      run: async () => {
        rec.ran = true;
        return { runId: null, failures: [] };
      },
    };
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db, { MARKET_HOURS_ENABLED: "true" }) as never, [spec]);

    const res = await scheduler.fetch(new Request("http://do/jobs/forcet/trigger?force=1"));

    expect(res.status).toBe(200);
    expect(rec.seeded).toBe(true);
    expect(rec.ran).toBe(true); // force bypassed the market gate and the item ran
  });

  it("plain trigger still respects the market gate (no-op while closed)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-04T12:00:00Z"));
    const db = new FakeDb();
    const { spec, rec } = recordingSpec();
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db, { MARKET_HOURS_ENABLED: "true" }) as never, [spec]);

    const res = await scheduler.fetch(new Request("http://do/jobs/t/trigger"));

    expect(res.status).toBe(200);
    expect(rec.seeded).toBe(false);
    expect(rec.ran).toBe(false); // gate still applies without force
  });

  it("force trigger returns 409 while another pass is in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-04T12:00:00Z"));
    const db = new FakeDb();
    const { spec, rec } = recordingSpec();
    const scheduler = new EtlScheduler(ctx(makeStorage({ passing: Date.now() })), env(db) as never, [spec]);

    const res = await scheduler.fetch(new Request("http://do/jobs/t/trigger?force=1"));

    expect(res.status).toBe(409);
    expect(rec.ran).toBe(false);
  });
});

describe("EtlScheduler — overnight wake for ungated jobs", () => {
  it("polls while market closed when an ungated job is already due", async () => {
    vi.useFakeTimers();
    // Sunday — equity session closed; next open is Monday 09:30 ET.
    vi.setSystemTime(new Date("2026-01-04T12:00:00Z"));
    const db = new FakeDb();
    db.jobState.set("crypto-spot-ohlc-daily", rowFrom({
      job_id: "crypto-spot-ohlc-daily",
      handler: "crypto-spot-ohlc-daily",
      market_gated: 0,
      next_attempt_after: 0,
    }));
    db.jobState.set("cboe-options", rowFrom({
      job_id: "cboe-options",
      handler: "cboe-options",
      market_gated: 1,
      next_attempt_after: 0,
    }));
    const scheduler = new EtlScheduler(
      ctx(makeStorage()),
      env(db, { MARKET_HOURS_ENABLED: "true", LOADER_POLL_INTERVAL_SECONDS: 60 }) as never,
      [],
    );
    const now = Date.now();
    const wake = await scheduler.computeNextWakeMs(now);
    expect(wake).toBe(now + 60_000);
  });

  it("sleeps until next open when no ungated job is due before then", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-04T12:00:00Z")); // Sunday
    const db = new FakeDb();
    // Ungated job already succeeded; next attempt is far past Monday open.
    db.jobState.set("ohlc-daily", rowFrom({
      job_id: "ohlc-daily",
      handler: "ohlc-daily",
      market_gated: 0,
      next_attempt_after: Date.parse("2026-01-06T12:00:00Z"),
    }));
    const scheduler = new EtlScheduler(
      ctx(makeStorage()),
      env(db, { MARKET_HOURS_ENABLED: "true", LOADER_POLL_INTERVAL_SECONDS: 60 }) as never,
      [],
    );
    const wake = await scheduler.computeNextWakeMs(Date.now());
    // Monday 2026-01-05 09:30 America/New_York = 14:30 UTC (EST).
    expect(wake).toBe(Date.parse("2026-01-05T14:30:00Z"));
  });

  it("ensureArmed pulls a far-out alarm earlier when an ungated job is due", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-04T12:00:00Z"));
    const storage = makeStorage();
    const farOpen = Date.parse("2026-01-05T14:30:00Z");
    await storage.setAlarm(farOpen);
    const db = new FakeDb();
    db.jobState.set("crypto-spot-ohlc-daily", rowFrom({
      job_id: "crypto-spot-ohlc-daily",
      handler: "crypto-spot-ohlc-daily",
      market_gated: 0,
      next_attempt_after: 0,
    }));
    const scheduler = new EtlScheduler(
      ctx(storage),
      env(db, { MARKET_HOURS_ENABLED: "true", LOADER_POLL_INTERVAL_SECONDS: 60 }) as never,
      [],
    );
    await scheduler.ensureArmed();
    const armed = await storage.getAlarm();
    expect(armed).toBe(Date.now() + 60_000);
    expect(armed!).toBeLessThan(farOpen);
  });
});

describe("EtlScheduler — item-store seeding (universe growth)", () => {
  function seedSpec(overrides: Partial<Record<string, unknown>> & { seedSize?: () => number } = {}) {
    const rec = { seeded: false, ran: false };
    const spec: JobSpec = {
      id: "t",
      marketGated: false,
      cadenceSeconds: 900,
      scope: "items",
      itemTable: "symbol_state",
      itemIdColumn: "symbol",
      seedSize: overrides.seedSize,
      seedItems: async () => {
        rec.seeded = true;
      },
      run: async (items) => {
        rec.ran = items.length > 0;
        return { runId: null, failures: [] };
      },
      ...(overrides as object),
    };
    return { spec, rec };
  }

  function runPass(scheduler: EtlScheduler, spec: JobSpec, db: FakeDb) {
    return scheduler.runJobPass(spec, rowFrom({ job_id: "t", handler: "t", market_gated: 0 }), 600000);
  }

  it("re-seeds additively when the item store is smaller than seedSize (universe grew)", async () => {
    const db = new FakeDb();
    // 2 of 3 expected items already present (progress preserved) — like the live
    // 503-row symbol_state after the universe grows to 583.
    for (const s of ["OLD1", "OLD2"]) {
      db.symbolState.set(s, { ...rowFrom({ job_id: "x" }) });
    }
    const { spec, rec } = seedSpec({ seedSize: () => 3 });
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    await runPass(scheduler, spec, db);

    expect(rec.seeded).toBe(true);
  });

  it("skips seeding when the item store already holds seedSize rows", async () => {
    const db = new FakeDb();
    for (const s of ["A", "B", "C"]) {
      db.symbolState.set(s, { ...rowFrom({ job_id: "x" }) });
    }
    const { spec, rec } = seedSpec({ seedSize: () => 3 });
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    await runPass(scheduler, spec, db);

    expect(rec.seeded).toBe(false);
  });

  it("legacy jobs without seedSize still seed only when the store is empty", async () => {
    const db = new FakeDb();
    db.symbolState.set("EXISTING", { ...rowFrom({ job_id: "x" }) });
    const { spec, rec } = seedSpec({}); // no seedSize
    const scheduler = new EtlScheduler(ctx(makeStorage()), env(db) as never);
    await runPass(scheduler, spec, db);

    expect(rec.seeded).toBe(false);
  });
});
