import { describe, expect, it, vi } from "vitest";
import { CboeContinuousLoader } from "./scheduler.js";

const RUNS_URL = "https://runs.example";
const CONTRACTS_URL = "https://contracts.example";
const UNDERLYINGS_URL = "https://underlyings.example";
const ERRORS_URL = "https://errors.example";

function cboePayload(symbol: string) {
  return {
    data: {
      current_price: 100,
      options: [
        { option: `${symbol}250117C00220000`, last: 2.5, bid: 2.4, ask: 2.6, volume: 100 },
        { option: `${symbol}260619P00150000`, last: 1.25, bid: 1.2, ask: 1.3, volume: 50 },
      ],
    },
  };
}

function makeStorage() {
  const store = new Map<string, unknown>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: unknown) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async getAlarm() {
      return store.get("__alarm__") ?? null;
    },
    async setAlarm(value: unknown) {
      store.set("__alarm__", value);
    },
  };
}

// Minimal D1 fake. `loader_meta` inserts are captured so the test can read the
// `last_pass` record tick() writes (the DO keeps no such state in storage).
function makeDb(dueSymbols: string[]) {
  const meta = new Map<string, string>();
  const bound = (sql: string) => {
    let args: unknown[] = [];
    const self = {
      bind: (...a: unknown[]) => {
        args = a;
        return self;
      },
      async first() {
        if (sql.includes("COUNT(*)")) return { c: 1 }; // pretend already seeded
        if (sql.includes("consecutive_failures")) return { consecutive_failures: 0 };
        return null;
      },
      async all() {
        if (sql.includes("SELECT symbol FROM")) return { results: dueSymbols.map((s) => ({ symbol: s })) };
        return { results: [] };
      },
      async run() {
        if (sql.includes("INSERT INTO loader_meta")) {
          meta.set(String(args[0]), String(args[1]));
        }
        return { success: true };
      },
    };
    return self;
  };
  return { prepare: (sql: string) => bound(sql), meta };
}

function baseEnv(db: unknown, symbols: string[]): Record<string, unknown> {
  return {
    LOADER_DB: db,
    MARKET_HOURS_ENABLED: "false", // bypass market-hours gating for the test
    CONTINUOUS_LOADER_ENABLED: "true",
    LOADER_BATCH_SIZE: 10,
    PIPELINE_RUNS_URL: RUNS_URL,
    PIPELINE_CONTRACTS_URL: CONTRACTS_URL,
    PIPELINE_UNDERLYINGS_URL: UNDERLYINGS_URL,
    PIPELINE_ERRORS_URL: ERRORS_URL,
    PIPELINE_AUTH_TOKEN: "token",
    SYMBOL_CONCURRENCY: 2,
    SYMBOL_DELAY_SECONDS: 0,
    HTTP_RETRIES: 1,
  };
}

describe("CboeContinuousLoader wiring", () => {
  it("tick() calls runSymbols in-process and updates symbol_state", async () => {
    const symbols = ["AAPL", "MSFT"];
    const captures: Array<{ url: string; body: string }> = [];
    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if ((init && init.method) === "POST") {
        captures.push({ url, body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const symbol = decodeURIComponent(url.split("/options/")[1].split(".")[0]);
      return new Response(JSON.stringify(cboePayload(symbol)), { status: 200 });
    };
    vi.stubGlobal("fetch", stub);

    const storage = makeStorage();
    const db = makeDb(symbols);
    const loader = new CboeContinuousLoader(
      { storage } as never,
      baseEnv(db, symbols) as never,
    );

    try {
      await loader.tick();
    } finally {
      vi.unstubAllGlobals();
    }

    const lastPass = JSON.parse(db.meta.get("last_pass:cboe-options") ?? "") as {
      run_id: string;
      attempted: number;
      succeeded: number;
      failed: number;
      transport_error: unknown;
    };
    expect(lastPass.run_id).toBeTruthy();
    expect(lastPass.attempted).toBe(2);
    expect(lastPass.succeeded).toBe(2);
    expect(lastPass.failed).toBe(0);
    expect(lastPass.transport_error).toBeNull();

    // Contracts for both symbols published; each symbol's underlying once.
    const contractRecords = captures
      .filter((c) => c.url === CONTRACTS_URL)
      .flatMap((c) => JSON.parse(c.body));
    expect(contractRecords).toHaveLength(4);
    const underlyingSymbols = captures
      .filter((c) => c.url === UNDERLYINGS_URL)
      .map((c) => JSON.parse(c.body)[0].symbol)
      .sort();
    expect(underlyingSymbols).toEqual([...symbols].sort());

    // Single-flight guard cleared after the pass.
    expect(await storage.get("passing")).toBeNull();
  });

  it("surfaces a per-symbol failure into D1 backoff, not a transport error", async () => {
    const symbols = ["AAPL", "NVR"];
    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if ((init && init.method) === "POST") {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const symbol = decodeURIComponent(url.split("/options/")[1].split(".")[0]);
      if (symbol === "NVR") return new Response("Forbidden", { status: 403 });
      return new Response(JSON.stringify(cboePayload(symbol)), { status: 200 });
    };
    vi.stubGlobal("fetch", stub);

    const storage = makeStorage();
    const db = makeDb(symbols);
    const loader = new CboeContinuousLoader(
      { storage } as never,
      baseEnv(db, symbols) as never,
    );

    try {
      await loader.tick();
    } finally {
      vi.unstubAllGlobals();
    }

    const lastPass = JSON.parse(db.meta.get("last_pass:cboe-options") ?? "") as {
      succeeded: number;
      failed: number;
      transport_error: unknown;
    };
    // NVR 403 fails at the CBOE fetch level -> runSymbols reports it as a
    // per-symbol failure, landing in backoff, NOT a transport error.
    expect(lastPass.succeeded).toBe(1);
    expect(lastPass.failed).toBe(1);
    expect(lastPass.transport_error).toBeNull();
  });

  it("backs the WHOLE batch off on a pass timeout instead of marking it success", async () => {
    const symbols = ["AAPL", "MSFT"];
    // Every request hangs forever -> runSymbols can never complete -> tick's
    // withTimeout rejects once LOADER_RUN_TIMEOUT_SECONDS elapses.
    const stub = () => new Promise<Response>(() => {});
    vi.stubGlobal("fetch", stub);

    const storage = makeStorage();
    const db = makeDb(symbols);
    const loader = new CboeContinuousLoader(
      { storage } as never,
      { ...baseEnv(db, symbols), LOADER_RUN_TIMEOUT_SECONDS: "0" } as never,
    );

    try {
      await loader.tick();
    } finally {
      vi.unstubAllGlobals();
    }

    const lastPass = JSON.parse(db.meta.get("last_pass:cboe-options") ?? "") as {
      run_id: string | null;
      attempted: number;
      succeeded: number;
      failed: number;
      transport_error: unknown;
    };
    // RunSymbols did not confirm completion, so nothing is recorded as loaded.
    // run_id stays null and the whole batch lands in backoff for the next tick.
    expect(lastPass.succeeded).toBe(0);
    expect(lastPass.failed).toBe(2);
    expect(lastPass.run_id).toBeNull();
    expect(String(lastPass.transport_error)).toMatch(/timed out/);
    // Single-flight guard still cleared.
    expect(await storage.get("passing")).toBeNull();
  });

  it("self-heals a stale `passing` flag so it cannot stall the loop", async () => {
    const symbols = ["AAPL"];
    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if ((init && init.method) === "POST") {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      const symbol = decodeURIComponent(url.split("/options/")[1].split(".")[0]);
      return new Response(JSON.stringify(cboePayload(symbol)), { status: 200 });
    };
    vi.stubGlobal("fetch", stub);

    const storage = makeStorage();
    // Simulate a legacy/stranded marker: an old boolean `true` left by a prior
    // deployment's mid-pass DO reset.
    await storage.put("passing", true);
    const db = makeDb(symbols);
    const loader = new CboeContinuousLoader(
      { storage } as never,
      baseEnv(db, symbols) as never,
    );

    try {
      await loader.tick();
    } finally {
      vi.unstubAllGlobals();
    }

    // The pass ran despite the stale flag (last_pass written) and the flag was
    // cleared by finally — the loop is not deadlocked.
    expect(db.meta.has("last_pass:cboe-options")).toBe(true);
    expect(await storage.get("passing")).toBeNull();
  });

  it("chunks markAttempts IN lists below D1's bind-variable limit", async () => {
    const inListSizes: number[] = [];
    const db = {
      prepare: (sql: string) => {
        const bound = {
          bind: (...args: unknown[]) => {
            if (sql.includes("SET last_attempt_at")) inListSizes.push(args.length - 1);
            return bound;
          },
          async first() {
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { success: true };
          },
        };
        return bound;
      },
    };
    const loader = new CboeContinuousLoader(
      { storage: makeStorage() } as never,
      { LOADER_DB: db } as never,
    );
    const symbols = Array.from({ length: 250 }, (_, i) => `S${String(i).padStart(3, "0")}`);
    await loader.markAttempts(symbols, 123);

    // 250 symbols split into 90/90/70 — each UPDATE stays under the ~100 limit.
    expect(inListSizes.length).toBe(Math.ceil(250 / 90));
    expect(Math.max(...inListSizes)).toBeLessThanOrEqual(90);
  });
});
