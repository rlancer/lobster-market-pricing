import { describe, expect, it, vi } from "vitest";
import {
  MVE_SWEEP_META_KEY,
  fetchKalshiParlayExecutorPack,
  fetchKalshiSportsParlayPack,
} from "./kalshi.js";
import type { MveSelectedLeg } from "./kalshi-mve.js";

/**
 * The open-MVE catalog is 150k+ markets; the hourly KXMVE tape sweeps it
 * across passes via a D1-persisted cursor. These tests pin the sweep
 * contract: resume, exhaustion restart, stale-cursor self-heal, sweep page
 * size, and the executor staying on the windowed page-0 head.
 */

const LEGS: MveSelectedLeg[] = [
  { event_ticker: "KXNFLGAME-26SEP20KC", market_ticker: "KXNFLGAME-26SEP20KC-KC", side: "yes" },
  { event_ticker: "KXNFLGAME-26SEP20BUF", market_ticker: "KXNFLGAME-26SEP20BUF-BUF", side: "yes" },
];

function combo(ticker: string, status = "active") {
  return {
    ticker,
    event_ticker: ticker,
    series_ticker: "KXMVE",
    title: "Chiefs win AND Bills win",
    category: "Sports",
    status,
    market_type: "multivariate",
    mve_collection_ticker: "KXMVECROSSCATEGORY-R",
    mve_selected_legs: LEGS,
    yes_bid_dollars: "0.05",
    yes_ask_dollars: "0.06",
    last_price_dollars: "0.05",
    no_bid_dollars: "0.94",
    no_ask_dollars: "0.95",
    volume_fp: "0",
    close_time: "2026-09-21T00:00:00Z",
  };
}

/** Cursor → page. Walking every entry in insertion order exhausts the catalog. */
const PAGES: Array<{ cursor: string; markets: unknown[]; next: string }> = [
  { cursor: "", markets: [combo("KXMVECROSSCATEGORY-SHARD1-A")], next: "c1" },
  { cursor: "c1", markets: [combo("KXMVECROSSCATEGORY-SHARD1-B")], next: "c2" },
  { cursor: "c2", markets: [combo("KXMVECROSSCATEGORY-SHARD1-C")], next: "c3" },
  { cursor: "c3", markets: [], next: "" },
];

function pageFor(cursor: string) {
  return PAGES.find((p) => p.cursor === cursor) ?? null;
}

interface MetaStmt {
  bind(...values: unknown[]): MetaStmt;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results: Array<Record<string, unknown>>; success: boolean }>;
  run(): Promise<unknown>;
}

interface MetaDb {
  prepare(query: string): MetaStmt;
  store: Map<string, string>;
}

function metaDb(initial: Record<string, string> = {}): MetaDb {
  const store = new Map(Object.entries(initial));
  return {
    prepare(query: string) {
      let binds: unknown[] = [];
      const stmt: MetaStmt = {
        bind(...values: unknown[]) {
          binds = values;
          return stmt;
        },
        async first() {
          if (query.includes("SELECT value FROM loader_meta")) {
            const value = store.get(String(binds[0]));
            return value != null ? { value } : null;
          }
          return null;
        },
        async all() {
          return { success: true, results: [] };
        },
        async run() {
          if (query.includes("INSERT INTO loader_meta")) {
            store.set(String(binds[0]), String(binds[1]));
          } else if (query.includes("DELETE FROM loader_meta")) {
            store.delete(String(binds[0]));
          }
          return { success: true };
        },
      };
      return stmt;
    },
    store,
  };
}

function storedCursor(db: MetaDb): string {
  const raw = db.store.get(MVE_SWEEP_META_KEY);
  if (!raw) return "";
  try {
    return String(JSON.parse(raw).cursor || "");
  } catch {
    return "";
  }
}

/** Mock fetch routing /markets mve pages by cursor; leg lookups return LEGS. */
function stubKalshiFetch(opts: { failCursors?: string[] } = {}) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    if (url.searchParams.get("mve_filter") === "only") {
      const cursor = url.searchParams.get("cursor") || "";
      if (opts.failCursors?.includes(cursor)) {
        return new Response("boom", { status: 500 });
      }
      const page = pageFor(cursor);
      if (!page) return new Response("unexpected cursor " + cursor, { status: 500 });
      return new Response(JSON.stringify({ markets: page.markets, cursor: page.next }), {
        status: 200,
      });
    }
    if (url.searchParams.has("tickers")) {
      return new Response(
        JSON.stringify({
          markets: LEGS.map((leg) => ({
            ticker: leg.market_ticker,
            event_ticker: leg.event_ticker,
            series_ticker: "KXNFLGAME",
            title: leg.market_ticker,
            status: "active",
            yes_bid_dollars: "0.40",
            yes_ask_dollars: "0.42",
            last_price_dollars: "0.41",
            volume_fp: "0",
            close_time: "2026-09-21T00:00:00Z",
          })),
        }),
        { status: 200 },
      );
    }
    return new Response("unexpected " + url.toString(), { status: 500 });
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { urls, fetchImpl };
}

function sweepEnv(db: MetaDb, extra: Record<string, unknown> = {}) {
  return {
    LOADER_DB: db,
    KALSHI_MVE_SWEEP_MAX_PAGES: 2,
    KALSHI_SPORTS_LOOKBACK_DAYS: "0",
    KALSHI_MIN_REQUEST_GAP_MS: 0,
    HTTP_RETRIES: 0,
    ...extra,
  };
}

describe("open-MVE sweep", () => {
  it("walks pages from the top and persists the continuation cursor", async () => {
    const db = metaDb();
    const { urls } = stubKalshiFetch();
    try {
      const pack = await fetchKalshiSportsParlayPack(sweepEnv(db));
      const tickers = pack.rows
        .filter((row) => row.market_type === "multivariate")
        .map((row) => row.market_ticker);
      expect(tickers).toEqual([
        "KXMVECROSSCATEGORY-SHARD1-A",
        "KXMVECROSSCATEGORY-SHARD1-B",
      ]);
      expect(urls[0]).toContain("limit=1000");
      expect(storedCursor(db)).toBe("c2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resumes from the persisted cursor on the next pass", async () => {
    const db = metaDb();
    const { urls } = stubKalshiFetch();
    try {
      await fetchKalshiSportsParlayPack(sweepEnv(db));
      const afterFirst = urls.length;
      const pack = await fetchKalshiSportsParlayPack(sweepEnv(db));
      const first = new URL(urls[afterFirst]);
      expect(first.searchParams.get("cursor")).toBe("c2");
      const tickers = pack.rows
        .filter((row) => row.market_type === "multivariate")
        .map((row) => row.market_ticker);
      expect(tickers).toEqual(["KXMVECROSSCATEGORY-SHARD1-C"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears the cursor when the walk exhausts the catalog, then restarts at page 0", async () => {
    const db = metaDb();
    const { urls } = stubKalshiFetch();
    try {
      await fetchKalshiSportsParlayPack(sweepEnv(db)); // pages 0-1, cursor c2
      await fetchKalshiSportsParlayPack(sweepEnv(db)); // page c2 -> c3 (empty page ends walk)
      expect(storedCursor(db)).toBe("");
      expect(db.store.has(MVE_SWEEP_META_KEY)).toBe(false);
      const afterSecond = urls.length;
      await fetchKalshiSportsParlayPack(sweepEnv(db));
      const first = new URL(urls[afterSecond]);
      expect(first.searchParams.get("cursor")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("self-heals a stale persisted cursor within the pass", async () => {
    const db = metaDb({ [MVE_SWEEP_META_KEY]: JSON.stringify({ cursor: "c2" }) });
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    stubKalshiFetch({ failCursors: ["c2"] });
    try {
      const pack = await fetchKalshiSportsParlayPack(sweepEnv(db));
      const tickers = pack.rows
        .filter((row) => row.market_type === "multivariate")
        .map((row) => row.market_ticker);
      expect(tickers).toEqual([
        "KXMVECROSSCATEGORY-SHARD1-A",
        "KXMVECROSSCATEGORY-SHARD1-B",
      ]);
      expect(warns.some((line) => line.includes("dropping stale cursor"))).toBe(true);
      expect(storedCursor(db)).toBe("c2");
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("degrades to a page-0 head window when no D1 handle is available", async () => {
    const { urls } = stubKalshiFetch();
    try {
      const env = sweepEnv(metaDb());
      delete (env as Record<string, unknown>).LOADER_DB;
      const pack = await fetchKalshiSportsParlayPack(env);
      const tickers = pack.rows
        .filter((row) => row.market_type === "multivariate")
        .map((row) => row.market_ticker);
      expect(tickers).toEqual([
        "KXMVECROSSCATEGORY-SHARD1-A",
        "KXMVECROSSCATEGORY-SHARD1-B",
      ]);
      expect(new URL(urls[0]).searchParams.get("cursor")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("streams pages through the two-leg filter — n>2 and crypto never accumulate (128MB DO cap)", async () => {
    const db = metaDb();
    const n3Stack = {
      ...combo("KXMVECROSSCATEGORY-SHARD1-N3"),
      mve_selected_legs: [
        ...LEGS,
        { event_ticker: "KXNFLGAME-26SEP20DET", market_ticker: "KXNFLGAME-26SEP20DET-DET", side: "yes" },
      ],
    };
    const cryptoStack = {
      ...combo("KXMVECROSSCATEGORY-SHARD1-CRYPTO"),
      mve_selected_legs: [
        { event_ticker: null, market_ticker: "KXBTC15M-26SEP20T10-77000", side: "yes" },
        { event_ticker: null, market_ticker: "KXETH15M-26SEP20T10-3000", side: "yes" },
      ],
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("mve_filter") === "only") {
        return new Response(JSON.stringify({
          markets: [combo("KXMVECROSSCATEGORY-SHARD1-TWO"), n3Stack, cryptoStack],
          cursor: "",
        }), { status: 200 });
      }
      if (url.searchParams.has("tickers")) {
        return new Response(JSON.stringify({
          markets: LEGS.map((leg) => ({
            ticker: leg.market_ticker,
            event_ticker: leg.event_ticker,
            series_ticker: "KXNFLGAME",
            title: leg.market_ticker,
            status: "active",
            yes_bid_dollars: "0.40",
            yes_ask_dollars: "0.42",
            last_price_dollars: "0.41",
            volume_fp: "0",
            close_time: "2026-09-21T00:00:00Z",
          })),
          cursor: "",
        }), { status: 200 });
      }
      return new Response("unexpected " + url.toString(), { status: 500 });
    });
    try {
      const pack = await fetchKalshiSportsParlayPack(sweepEnv(db));
      const tickers = pack.rows
        .filter((row) => row.market_type === "multivariate")
        .map((row) => row.market_ticker);
      expect(tickers).toEqual(["KXMVECROSSCATEGORY-SHARD1-TWO"]);
      expect(storedCursor(db)).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("executor candidate scan stays windowed", () => {
  it("ignores the sweep cursor and leaves it untouched", async () => {
    const db = metaDb({ [MVE_SWEEP_META_KEY]: JSON.stringify({ cursor: "c2" }) });
    const { urls } = stubKalshiFetch();
    try {
      const pack = await fetchKalshiParlayExecutorPack({
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        HTTP_RETRIES: 0,
        KALSHI_MVE_MAX_PAGES: 1,
        LOADER_DB: db,
      });
      const first = new URL(urls[0]);
      expect(first.searchParams.get("mve_filter")).toBe("only");
      expect(first.searchParams.get("limit")).toBe("200");
      expect(first.searchParams.get("cursor")).toBeNull();
      expect(storedCursor(db)).toBe("c2");
      // Windowed head only: page 0's combo, no continuation request.
      const comboTickers = pack.rows
        .filter((row) => row.market_type === "multivariate")
        .map((row) => row.market_ticker);
      expect(comboTickers).toEqual(["KXMVECROSSCATEGORY-SHARD1-A"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
