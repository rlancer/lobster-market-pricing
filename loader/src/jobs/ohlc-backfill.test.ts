import { describe, expect, it, vi } from "vitest";
import { ohlcBackfillJob, windowBounds, BACKFILL_WINDOW_DAYS } from "./ohlc-backfill.js";
import {
  parseCorporateActions,
  parseYahooChart,
  publishOhlcRange,
  realizedVols,
  normalizeCorporateActionRecords,
  CORPORATE_ACTION_FIELDS,
  type DailyBar,
} from "../ohlc.js";
import { securityIdForTicker, uuidFromSeed } from "../symbology.js";
import type { SchedulerEnv } from "../scheduler.js";

const OHLC_URL = "https://ohlc.test/{symbol}?period1={period1}&period2={period2}&events=div%2Csplit";
const PIPELINE_OHLC_URL = "https://pipeline.test/ohlc";
const PIPELINE_RV_URL = "https://pipeline.test/rv";
const PIPELINE_CA_URL = "https://pipeline.test/ca";

function num(env: SchedulerEnv): number {
  return Math.max(1, Math.floor(Number(env.OHLC_CONCURRENCY) || 4));
}

// Yahoo v8 payload with quote + adjclose + an events block (a dividend AND a
// split). Two daily bars.
function rangePayload(symbol: string): unknown {
  return {
    chart: {
      result: [
        {
          meta: { symbol, gmtoffset: -18000 },
          timestamp: [1767312000, 1767398400],
          indicators: {
            quote: [
              { open: [100, 101], high: [101, 102], low: [99, 100], close: [100.5, 101.5], volume: [1000, 2000] },
            ],
            adjclose: [{ adjclose: [100.5, 101.5] }],
          },
          events: {
            dividends: { "1767312000": { amount: 0.25, date: 1767312000 } },
            splits: { "1767398400": { numerator: 4, denominator: 1, splitRatio: "4:1", date: 1767398400 } },
          },
        },
      ],
    },
  };
}

describe("windowBounds", () => {
  it("computes a ~2y epoch-second window ending now", () => {
    const now = Date.now();
    const { period1, period2 } = windowBounds(now);
    expect(period2).toBe(Math.floor(now / 1000));
    expect(period2 - period1).toBe(BACKFILL_WINDOW_DAYS * 86400);
  });
});

describe("realizedVols uses adjusted closes (split-resilient)", () => {
  it("does not inject a spurious return when raw close jumps from a split but adjclose is continuous", () => {
    const bars: DailyBar[] = [];
    // 92 days. adjclose rises 0.1%/day (smooth → low vol). raw close mirrors
    // adjclose except a 4-for-1 split: close drops 75% mid-series.
    let adj = 100;
    for (let i = 0; i < 92; i++) {
      adj *= 1.001;
      const close = i === 46 ? adj / 4 : adj; // split drop in RAW close only
      bars.push({
        date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
        open: close, high: close, low: close, close,
        adjustedClose: adj, volume: 1000,
      });
    }
    const rv = realizedVols(bars);
    // With adjclose the split day contributes a normal-sized return, so 90d vol
    // stays low. If we naively used raw close it would spike far above this.
    expect(rv.realized_vol_90d).not.toBeNull();
    expect(rv.realized_vol_90d!).toBeLessThan(0.2);
  });

  it("falls back to raw close when adjclose is absent", () => {
    const bars: DailyBar[] = [];
    let c = 100;
    for (let i = 0; i < 92; i++) {
      c *= 1.01;
      bars.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, open: c, high: c, low: c, close: c, adjustedClose: null, volume: 1000 });
    }
    expect(realizedVols(bars).realized_vol_90d).not.toBeNull();
  });
});

describe("parseYahooChart + parseCorporateActions", () => {
  it("reads adjclose and emits dividend + split records in exact field order", () => {
    const bars = parseYahooChart(rangePayload("AAPL"), "AAPL");
    expect(bars).toHaveLength(2);
    expect(bars[0].adjustedClose).toBe(100.5);

    const sid = securityIdForTicker("AAPL");
    const actions = parseCorporateActions(rangePayload("AAPL"), "AAPL", "yahoo", "r", "t", sid);
    expect(actions.map((a) => a.action_type).sort()).toEqual(["DIVIDEND", "SPLIT"]);
    const split = actions.find((a) => a.action_type === "SPLIT")!;
    expect(split.numerator).toBe(4);
    expect(split.denominator).toBe(1);
    expect(split.security_id).toBe(sid);

    const recs = normalizeCorporateActionRecords(actions);
    expect(recs[0] && Object.keys(recs[0])).toEqual([...CORPORATE_ACTION_FIELDS]);
  });
});

describe("publishOhlcRange publishes OHLC + RV + corporate actions", () => {
  function env(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      OHLC_URL_TEMPLATE: OHLC_URL,
      OHLC_SOURCE: "yahoo",
      PIPELINE_OHLC_URL,
      PIPELINE_REALIZED_VOL_URL: PIPELINE_RV_URL,
      PIPELINE_CORPORATE_ACTIONS_URL: PIPELINE_CA_URL,
      PIPELINE_AUTH_TOKEN: "tok",
      HTTP_RETRIES: 0,
      ...overrides,
    };
  }

  it("publishes ohlc bars, one rv record, and corporate-action records", async () => {
    const posts: Array<{ url: string; body: string }> = [];
    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (init && init.method === "POST") {
        posts.push({ url, body: String(init?.body) });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const symbol = decodeURIComponent(url.split("/").slice(-1)[0].split("?")[0]) || "AAPL";
      return new Response(JSON.stringify(rangePayload(symbol.replace("?", ""))), { status: 200 });
    };
    vi.stubGlobal("fetch", stub);
    let result;
    try {
      result = await publishOhlcRange("AAPL", 1700000000, 1750000000, env() as never, securityIdForTicker("AAPL"));
    } finally {
      vi.unstubAllGlobals();
    }

    expect(result.bar_count).toBe(2);
    expect(result.corporate_action_count).toBe(2);
    expect(result.published_ohlc).toBe(true);
    expect(result.published_corporate_actions).toBe(true);
    expect(result.security_id).toBe(securityIdForTicker("AAPL"));

    const byUrl = (u: string) => posts.filter((p) => p.url === u).map((p) => JSON.parse(p.body)).flat();
    const ohlcRecs = byUrl(PIPELINE_OHLC_URL);
    const rvRecs = posts.filter((p) => p.url === PIPELINE_RV_URL).map((p) => JSON.parse(p.body));
    const caRecs = byUrl(PIPELINE_CA_URL);
    expect(ohlcRecs).toHaveLength(2);
    expect(ohlcRecs.every((r) => r.symbol === "AAPL" && r.source === "yahoo")).toBe(true);
    expect(rvRecs).toHaveLength(1);
    expect(caRecs.map((r) => r.action_type).sort()).toEqual(["DIVIDEND", "SPLIT"]);
  });
});

describe("ohlcBackfillJob", () => {
  function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
    return { OHLC_CONCURRENCY: 2, ...overrides };
  }

  it("dry-runs: with no pipeline URLs it runs no fetches and reports no work", async () => {
    let fetched = 0;
    const stub = async () => { fetched++; return new Response("{}", { status: 200 }); };
    vi.stubGlobal("fetch", stub);
    try {
      const job = ohlcBackfillJob(env());
      const result = await job.run(["AAPL"], env());
      expect(result.failures).toEqual([]);
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("seeds the item store with ticker-derived security_ids", async () => {
    const inserts: Array<{ symbol: string; security_id: string }> = [];
    const fakeDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          if (sql.includes("INSERT OR IGNORE INTO ohlc_backfill_state")) {
            inserts.push({ symbol: String(args[0]), security_id: String(args[1]) });
          }
          return { run: async () => ({ success: true }) };
        },
      }),
    };
    await ohlcBackfillJob(env()).seedItems(fakeDb as never);
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts[0].security_id).toBe(securityIdForTicker(inserts[0].symbol));
  });

  it("supports a per-pass run id and collects per-symbol failures", async () => {
    const posts: string[] = [];
    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (init && init.method === "POST") { posts.push(url); return new Response("{}", { status: 200 }); }
      const symbol = decodeURIComponent(url.split("/").slice(-1)[0].split("?")[0]) || "AAPL";
      if (symbol === "BAD") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(rangePayload(symbol)), { status: 200 });
    };
    vi.stubGlobal("fetch", stub);
    try {
      const runId = "11111111-1111-4111-8111-111111111111";
      const job = ohlcBackfillJob(env({ runId: () => runId }));
      const runEnv: SchedulerEnv = {
        ...env(),
        PIPELINE_OHLC_URL,
        PIPELINE_REALIZED_VOL_URL: PIPELINE_RV_URL,
        PIPELINE_CORPORATE_ACTIONS_URL: PIPELINE_CA_URL,
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        runId: () => runId,
      } as never as SchedulerEnv;
      const result = await job.run(["AAPL", "BAD"], runEnv);
      expect(result.runId).toBe(runId);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].symbol).toBe("BAD");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uuidFromSeed is deterministic", () => {
    expect(uuidFromSeed("ticker:AAPL")).toBe(uuidFromSeed("ticker:AAPL"));
    expect(uuidFromSeed("ticker:AAPL")).not.toBe(uuidFromSeed("ticker:MSFT"));
  });
});
