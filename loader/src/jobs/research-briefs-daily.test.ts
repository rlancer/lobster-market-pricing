import { describe, expect, it, vi } from "vitest";
import {
  researchApiBase,
  researchBriefsDailyJob,
  researchWarmConfigured,
  warmResearchBatch,
} from "./research-briefs-daily.js";
import type { SchedulerEnv } from "../scheduler.js";

describe("research-briefs-daily config", () => {
  it("requires RESEARCH_API_BASE + ADMIN_TOKEN", () => {
    expect(researchWarmConfigured({})).toBe(false);
    expect(researchWarmConfigured({ RESEARCH_API_BASE: "https://api.example" })).toBe(false);
    expect(researchWarmConfigured({ ADMIN_TOKEN: "secret" })).toBe(false);
    expect(
      researchWarmConfigured({
        RESEARCH_API_BASE: "https://api.example/",
        ADMIN_TOKEN: "secret",
      }),
    ).toBe(true);
    expect(researchApiBase({ RESEARCH_API_BASE: "https://api.example/" })).toBe(
      "https://api.example",
    );
  });
});

describe("researchBriefsDailyJob", () => {
  it("is item-scoped, ungated, daily, and dry-runs without credentials", async () => {
    const job = researchBriefsDailyJob({});
    expect(job.id).toBe("research-briefs-daily");
    expect(job.scope).toBe("items");
    expect(job.marketGated).toBe(false);
    expect(job.cadenceSeconds).toBe(86400);
    expect(job.itemTable).toBe("research_brief_state");
    expect(await job.seedSize?.(null as never)).toBeGreaterThan(500);

    const result = await job.run(["AAPL", "MSFT"], {});
    expect(result.runId).toBeNull();
    expect(result.failures).toEqual([]);
  });

  it("seeds research_brief_state for the universe", async () => {
    const inserts: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT OR IGNORE INTO research_brief_state")) {
              inserts.push(String(args[0]));
            }
            return { success: true };
          },
          first: async () => ({ c: 0 }),
          all: async () => ({ results: [], success: true }),
        }),
      }),
    };
    const job = researchBriefsDailyJob({ LOADER_BACKOFF_BASE_SECONDS: "60" });
    await job.seedItems(db as never);
    expect(inserts.length).toBe(await job.seedSize?.(db as never));
    expect(inserts).toContain("AAPL");
  });
});

describe("warmResearchBatch", () => {
  it("POSTs tickers with Bearer ADMIN_TOKEN and maps per-ticker failures", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          attempted: 2,
          warmed: 1,
          failed: 1,
          results: [
            { ticker: "AAPL", ok: true },
            { ticker: "BAD", ok: false, error: "boom" },
          ],
        }),
        { status: 200 },
      ),
    );
    const env: SchedulerEnv = {
      RESEARCH_API_BASE: "https://api-dev.lobster.mp",
      ADMIN_TOKEN: "admin-secret",
      RESEARCH_WARM_CONCURRENCY: "2",
    };
    const out = await warmResearchBatch(["AAPL", "BAD"], env, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://api-dev.lobster.mp/api/research/warm");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers).toMatchObject({
      Authorization: "Bearer admin-secret",
    });
    const body = JSON.parse(String(call[1].body));
    expect(body).toEqual({ tickers: ["AAPL", "BAD"], concurrency: 2 });
    expect(out.failures).toEqual([{ symbol: "BAD", error: "boom" }]);
    expect(out.runId).toBeTruthy();
  });

  it("throws on HTTP errors from the warm endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    await expect(
      warmResearchBatch(
        ["AAPL"],
        { RESEARCH_API_BASE: "https://api.example", ADMIN_TOKEN: "x" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/unauthorized/);
  });
});
