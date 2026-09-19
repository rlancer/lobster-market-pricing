import { describe, expect, it, vi } from "vitest";
import {
  SETTLEMENT_QUEUE_TABLE,
  drainSettlementQueue,
  enqueueSettlementRows,
  isSettlementQueueCandidate,
  publishKalshiSeries,
  type KalshiMarketRow,
} from "./kalshi.js";
import { encodeMveCategory, type MveSelectedLeg } from "./kalshi-mve.js";

/**
 * Grade-on-close queue: every tape two-leg combo and every RFQ / fill ticker
 * must eventually resolve to a source=kalshi_settlement row, regardless of
 * what the windowed settled/closed lookback scans happen to fetch.
 */

const TWO_GAME_LEGS: MveSelectedLeg[] = [
  { event_ticker: "KXNFLGAME-26SEP20KC", market_ticker: "KXNFLGAME-26SEP20KC-KC", side: "yes" },
  { event_ticker: "KXNFLGAME-26SEP20BUF", market_ticker: "KXNFLGAME-26SEP20BUF-BUF", side: "yes" },
];

const THREE_LEGS: MveSelectedLeg[] = [
  { event_ticker: "KXNFLGAME-A", market_ticker: "KXNFLGAME-A-KC", side: "yes" },
  { event_ticker: "KXNFLGAME-A", market_ticker: "KXNFLGAME-A-BUF", side: "yes" },
  { event_ticker: "KXNFLGAME-A", market_ticker: "KXNFLGAME-A-DET", side: "yes" },
];

const TWO_LEG_CATEGORY = encodeMveCategory("KXMVECROSSCATEGORY-SHARD1-R", TWO_GAME_LEGS);
const THREE_LEG_CATEGORY = encodeMveCategory("KXMVECROSSCATEGORY-SHARD1-R", THREE_LEGS);

interface QueueRow {
  close_time: string;
  enqueued_at: number;
}

interface QueueStmt {
  bind(...values: unknown[]): QueueStmt;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results: Array<Record<string, unknown>>; success: boolean }>;
  run(): Promise<unknown>;
}

interface QueueDb {
  prepare(query: string): QueueStmt;
  rows: Map<string, QueueRow>;
}

/** D1's per-statement bound-parameter cap — the mock enforces it so
  regressions like the 2026-09-19 "too many SQL variables" enqueue incident
  fail tests instead of production. */
const D1_MAX_BINDS = 100;

/** Minimal D1 stand-in for the settlement queue table. */
function memoryQueueDb(): QueueDb {
  const rows = new Map<string, QueueRow>();
  const stmtFor = (query: string): QueueStmt => {
    let binds: unknown[] = [];
    const stmt = {
      bind(...values: unknown[]) {
        binds = values;
        return stmt;
      },
      async first() {
        return null;
      },
      async all(): Promise<{ results: Array<Record<string, unknown>>; success: boolean }> {
        if (query.includes(`SELECT market_ticker FROM ${SETTLEMENT_QUEUE_TABLE}`)) {
          const [dueIso, limit] = binds as [string, number];
          return {
            success: true,
            results: [...rows.entries()]
              .filter(([, row]) => row.close_time < dueIso)
              .sort((a, b) => a[1].close_time.localeCompare(b[1].close_time))
              .slice(0, limit)
              .map(([market_ticker]) => ({ market_ticker })),
          };
        }
        return { success: true, results: [] };
      },
      async run() {
        if (binds.length > D1_MAX_BINDS) {
          throw new Error(
            `D1_ERROR: too many SQL variables (${binds.length} > ${D1_MAX_BINDS}): SQLITE_ERROR`,
          );
        }
        if (query.includes(`INSERT OR IGNORE INTO ${SETTLEMENT_QUEUE_TABLE}`)) {
          for (let i = 0; i + 2 < binds.length; i += 3) {
            const ticker = String(binds[i]);
            if (!rows.has(ticker)) {
              rows.set(ticker, { close_time: String(binds[i + 1]), enqueued_at: Number(binds[i + 2]) });
            }
          }
        } else if (query.includes(`DELETE FROM ${SETTLEMENT_QUEUE_TABLE} WHERE close_time < ?`)) {
          const pruneIso = String(binds[0]);
          for (const [ticker, row] of [...rows]) {
            if (row.close_time < pruneIso) rows.delete(ticker);
          }
        } else if (query.includes(`DELETE FROM ${SETTLEMENT_QUEUE_TABLE} WHERE market_ticker IN`)) {
          for (const bind of binds) rows.delete(String(bind));
        }
        return { success: true };
      },
    };
    return stmt;
  };
  return {
    prepare(query: string) {
      return stmtFor(query);
    },
    rows,
  };
}

function tapeRow(overrides: Partial<KalshiMarketRow>): KalshiMarketRow {
  return {
    series_ticker: "KXMVE",
    market_ticker: "KXMVECROSSCATEGORY-SHARD1-X",
    event_ticker: null,
    title: "combo",
    yes_subtitle: null,
    theme: "sports",
    category: TWO_LEG_CATEGORY,
    status: "active",
    market_type: "multivariate",
    yes_bid: 0,
    yes_ask: 0,
    yes_last: 0,
    no_bid: 1,
    no_ask: 1,
    volume: 0,
    volume_24h: 0,
    open_interest: 0,
    liquidity: null,
    floor_strike: null,
    close_time: "2026-09-20T01:00:00Z",
    expiration_time: null,
    related_symbol: null,
    source: "kalshi",
    ...overrides,
  };
}

describe("isSettlementQueueCandidate", () => {
  it("queues listed two-leg combos and RFQ / fill pins, nothing else", () => {
    expect(isSettlementQueueCandidate(tapeRow({}))).toBe(true);
    expect(isSettlementQueueCandidate(tapeRow({ source: "kalshi_rfq" }))).toBe(true);
    expect(isSettlementQueueCandidate(tapeRow({ source: "kalshi_parlay_fill" }))).toBe(true);
    expect(isSettlementQueueCandidate(tapeRow({ category: THREE_LEG_CATEGORY }))).toBe(false);
    expect(isSettlementQueueCandidate(tapeRow({ category: null, market_type: "binary", source: "kalshi" }))).toBe(false);
    expect(isSettlementQueueCandidate(tapeRow({ source: "kalshi_settlement" }))).toBe(false);
  });
});

describe("enqueueSettlementRows", () => {
  it("stages tape candidates with a close_time once each", async () => {
    const db = memoryQueueDb();
    const staged = await enqueueSettlementRows(
      { LOADER_DB: db as never },
      [
        tapeRow({ market_ticker: "COMBO-A" }),
        tapeRow({ market_ticker: "COMBO-A" }),
        tapeRow({ market_ticker: "COMBO-LEG", category: null, market_type: "binary" }),
        tapeRow({ market_ticker: "COMBO-N3", category: THREE_LEG_CATEGORY }),
        tapeRow({ market_ticker: "COMBO-NO-CLOSE", close_time: null }),
      ],
      Date.parse("2026-09-18T12:00:00.000Z"),
    );
    expect(staged).toBe(1);
    expect([...db.rows.keys()]).toEqual(["COMBO-A"]);
    expect(db.rows.get("COMBO-A")?.close_time).toBe("2026-09-20T01:00:00Z");
  });

  it("enqueues 100+ candidates in D1-legal chunks (33 tuples = 99 binds)", async () => {
    const db = memoryQueueDb();
    const rows = Array.from({ length: 100 }, (_, i) =>
      tapeRow({ market_ticker: `COMBO-${i}` }),
    );
    const staged = await enqueueSettlementRows(
      { LOADER_DB: db as never },
      rows,
      Date.parse("2026-09-18T12:00:00.000Z"),
    );
    // The mock throws on >100 binds — 100 tuples must split into 33+33+34
    // chunks and every row must land (the 2026-09-19 incident lost them all).
    expect(staged).toBe(100);
    expect(db.rows.size).toBe(100);
  });
  it("is a no-op without a D1 handle", async () => {
    expect(await enqueueSettlementRows({}, [tapeRow({})])).toBe(0);
  });
});

describe("drainSettlementQueue", () => {
  const NOW = Date.parse("2026-09-21T12:00:00.000Z");

  function stubTickersFetch(marketsByTicker: Record<string, unknown>) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("tickers=")) {
        const markets = Object.values(marketsByTicker);
        return new Response(JSON.stringify({ markets, cursor: "" }), { status: 200 });
      }
      return new Response("unexpected " + url, { status: 500 });
    });
    return urls;
  }

  it("grades due settled tickers, publishes 0/1 rows, and empties the queue", async () => {
    const db = memoryQueueDb();
    await enqueueSettlementRows(
      { LOADER_DB: db as never },
      [
        tapeRow({ market_ticker: "DUE-SETTLED", close_time: "2026-09-21T01:00:00Z" }),
        tapeRow({ market_ticker: "NOT-DUE", close_time: "2026-09-22T01:00:00Z" }),
      ],
      NOW,
    );
    const urls = stubTickersFetch({
      "DUE-SETTLED": {
        ticker: "DUE-SETTLED",
        event_ticker: "DUE-SETTLED",
        series_ticker: "KXMVE",
        title: "combo",
        status: "finalized",
        result: "yes",
        close_time: "2026-09-21T01:00:00Z",
      },
    });
    try {
      const rows = await drainSettlementQueue({ LOADER_DB: db as never, HTTP_RETRIES: 0, KALSHI_MIN_REQUEST_GAP_MS: 0 }, NOW);
      expect(rows).toHaveLength(1);
      expect(rows[0].market_ticker).toBe("DUE-SETTLED");
      expect(rows[0].source).toBe("kalshi_settlement");
      expect(rows[0].yes_last).toBe(1);
      expect(rows[0].status).toBe("settled");
      expect(rows[0].fetched_at).toBe("2026-09-21T01:00:00Z");
      expect(urls.some((u) => u.includes("tickers=DUE-SETTLED"))).toBe(true);
      expect([...db.rows.keys()]).toEqual(["NOT-DUE"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps still-trading and purged tickers queued for the next pass", async () => {
    const db = memoryQueueDb();
    await enqueueSettlementRows(
      { LOADER_DB: db as never },
      [
        tapeRow({ market_ticker: "STILL-OPEN", close_time: "2026-09-21T01:00:00Z" }),
        tapeRow({ market_ticker: "PURGED", close_time: "2026-09-21T02:00:00Z" }),
      ],
      NOW,
    );
    stubTickersFetch({
      "STILL-OPEN": { ticker: "STILL-OPEN", status: "active", close_time: "2026-09-21T01:00:00Z" },
    });
    try {
      const rows = await drainSettlementQueue({ LOADER_DB: db as never, HTTP_RETRIES: 0, KALSHI_MIN_REQUEST_GAP_MS: 0 }, NOW);
      expect(rows).toHaveLength(0);
      expect([...db.rows.keys()].sort()).toEqual(["PURGED", "STILL-OPEN"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prunes entries past the retention window", async () => {
    const db = memoryQueueDb();
    await enqueueSettlementRows(
      { LOADER_DB: db as never },
      [
        tapeRow({ market_ticker: "ANCIENT", close_time: "2026-01-01T00:00:00Z" }),
        tapeRow({ market_ticker: "RECENT", close_time: "2026-09-21T00:00:00Z" }),
      ],
      NOW,
    );
    stubTickersFetch({});
    try {
      await drainSettlementQueue({ LOADER_DB: db as never, HTTP_RETRIES: 0, KALSHI_MIN_REQUEST_GAP_MS: 0 }, NOW);
      expect([...db.rows.keys()]).toEqual(["RECENT"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("publishKalshiSeries grade-on-close wiring", () => {
  it("drains queued settlements into the KXMVE publish batch", async () => {
    const db = memoryQueueDb();
    const posts: Array<Record<string, unknown>[]> = [];
    const NOW = Date.parse("2026-09-21T12:00:00.000Z");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("mve_filter=only")) {
        return new Response(JSON.stringify({ markets: [], cursor: "" }), { status: 200 });
      }
      if (url.includes("tickers=")) {
        return new Response(
          JSON.stringify({
            markets: [
              {
                ticker: "RFQ-PINNED",
                event_ticker: "RFQ-PINNED",
                series_ticker: "KXMVE",
                title: "pinned",
                category: "Sports",
                status: "finalized",
                result: "no",
                close_time: "2026-09-21T01:00:00Z",
              },
            ],
            cursor: "",
          }),
          { status: 200 },
        );
      }
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("unexpected " + url, { status: 500 });
    });
    try {
      // Pre-seeded backlog: an RFQ ticker graded by no lookback window.
      await db.prepare(
        `INSERT OR IGNORE INTO ${SETTLEMENT_QUEUE_TABLE} (market_ticker, close_time, enqueued_at) VALUES (?, ?, ?)`,
      ).bind("RFQ-PINNED", "2026-09-21T01:00:00Z", NOW).run();
      const result = await publishKalshiSeries("KXMVE", {
        LOADER_DB: db as never,
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        KALSHI_SPORTS_LOOKBACK_DAYS: 0,
        KALSHI_RFQ_PROBE_ENABLED: "",
        now: () => NOW,
        runId: () => "run-queue",
      });
      // The open scan returned nothing to publish except the drained grade.
      expect(result.published).toBe(true);
      const body = posts[0] as Array<Record<string, unknown>>;
      const graded = body.find((row) => row.market_ticker === "RFQ-PINNED");
      expect(graded?.source).toBe("kalshi_settlement");
      expect(graded?.yes_last).toBe(0);
      expect([...db.rows.keys()]).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
