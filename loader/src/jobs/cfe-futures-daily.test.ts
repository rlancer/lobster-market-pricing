import { describe, expect, it, vi } from "vitest";
import { cfeFuturesDailyJob } from "./cfe-futures-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

const PIPELINE_SETTLEMENTS = "https://pipeline.test/futures-settlements";
const PIPELINE_QUOTES = "https://pipeline.test/futures-quotes";

const SETTLEMENT_CSV = [
  "Product,Symbol,Expiration Date,Price",
  "VX,VX/U6,2026-09-16,17.9201",
  "VX,VX34/Q6,2026-08-26,15.5594",
  "IBHY,IBHY/U6,2026-09-01,183.975",
].join("\n");

function quoteJson(symbol: string): unknown {
  return {
    data: {
      symbol,
      security_type: "future",
      current_price: 18.0,
      bid: 17.9,
      ask: 18.1,
      open: 18.0,
      high: 18.5,
      low: 17.5,
      close: 18.0,
      prev_day_close: 18.2,
      volume: 100,
      open_interest: 1000,
      settlement_price: 18.05,
      settlement_date: "2026-09-16T00:00:00",
    },
  };
}

function env(overrides: Record<string, unknown> = {}): SchedulerEnv {
  return {
    CFE_SETTLEMENT_CSV_URL: "https://cboe.test/settlement.csv",
    CFE_QUOTE_URL_TEMPLATE: "https://cboe.test/quotes/{symbol}.json",
    HTTP_RETRIES: 0,
    ...overrides,
  };
}

describe("cfe-futures-daily job adapter", () => {
  it("dry-runs: with no pipeline URLs it runs no fetches", async () => {
    let fetched = 0;
    vi.stubGlobal("fetch", async () => {
      fetched += 1;
      throw new Error("should never fetch in dry-run");
    });
    try {
      const job = cfeFuturesDailyJob(env());
      expect(job.id).toBe("cfe-futures-daily");
      expect(job.scope).toBe("batch");
      expect(job.universe()).toEqual(["settlements", "quotes"]);
      const run = await job.run(["settlements", "quotes"], env());
      expect(run).toEqual({ runId: null, failures: [] });
      expect(fetched).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes settlements + monthals quotes and shares one run_id", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes("settlement.csv")) {
        return new Response(SETTLEMENT_CSV, { status: 200 });
      }
      const m = url.match(/quotes\/([^/.]+)\.json/);
      const symbol = m ? decodeURIComponent(m[1]) : "UNK";
      return new Response(JSON.stringify(quoteJson(symbol)), { status: 200 });
    });
    const jobEnv = env({
      PIPELINE_FUTURES_SETTLEMENTS_URL: PIPELINE_SETTLEMENTS,
      PIPELINE_FUTURES_QUOTES_URL: PIPELINE_QUOTES,
      PIPELINE_AUTH_TOKEN: "tok",
      runId: () => "run-cfe",
      now: () => new Date("2026-08-17T12:00:00.000Z"),
    });
    try {
      const job = cfeFuturesDailyJob(jobEnv);
      const run = await job.run(["settlements", "quotes"], jobEnv);
      expect(run.failures).toEqual([]);
      expect(run.runId).toBe("run-cfe");
    } finally {
      vi.unstubAllGlobals();
    }
    const settlePosts = posts.filter((p) => p.url === PIPELINE_SETTLEMENTS);
    const quotePosts = posts.filter((p) => p.url === PIPELINE_QUOTES);
    expect(settlePosts).toHaveLength(1);
    expect(quotePosts).toHaveLength(1);
    const settleRows = settlePosts[0].body as Array<{ contract_symbol: string; run_id: string }>;
    expect(settleRows.map((r) => r.contract_symbol).sort()).toEqual([
      "IBHY/U6", "VX/U6", "VX34/Q6",
    ]);
    expect(settleRows.every((r) => r.run_id === "run-cfe")).toBe(true);
    const quoteRows = quotePosts[0].body as Array<{ contract_symbol: string; root: string }>;
    // Weeklies skipped; monthals VX/U6 → VXU26 and IBHY/U6 → IBHYU26.
    expect(quoteRows.map((r) => r.contract_symbol).sort()).toEqual(["IBHYU26", "VXU26"]);
    expect(quoteRows.every((r) => r.root === "VX" || r.root === "IBHY")).toBe(true);
  });

  it("records a per-pass failure without aborting the other", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init && init.method) === "POST") {
        if (url === PIPELINE_SETTLEMENTS) {
          return new Response("nope", { status: 500 });
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.includes("settlement.csv")) return new Response(SETTLEMENT_CSV, { status: 200 });
      const m = url.match(/quotes\/([^/.]+)\.json/);
      const symbol = m ? decodeURIComponent(m[1]) : "UNK";
      return new Response(JSON.stringify(quoteJson(symbol)), { status: 200 });
    });
    const jobEnv = env({
      PIPELINE_FUTURES_SETTLEMENTS_URL: PIPELINE_SETTLEMENTS,
      PIPELINE_FUTURES_QUOTES_URL: PIPELINE_QUOTES,
      HTTP_RETRIES: 0,
      runId: () => "run-2",
      now: () => new Date("2026-08-17T12:00:00.000Z"),
    });
    try {
      const job = cfeFuturesDailyJob(jobEnv);
      const run = await job.run(["settlements", "quotes"], jobEnv);
      expect(run.failures).toHaveLength(1);
      expect(run.failures[0].symbol).toBe("settlements");
      expect(run.failures[0].error).toMatch(/HTTP 500/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
