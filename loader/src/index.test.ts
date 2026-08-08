import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";

const RUNS_URL = "https://runs.example";
const CONTRACTS_URL = "https://contracts.example";
const UNDERLYINGS_URL = "https://underlyings.example";
const ERRORS_URL = "https://errors.example";

function cboePayload(symbol: string) {
  return {
    data: {
      current_price: 100,
      options: [{ option: `${symbol}250117C00220000`, last: 2.5, bid: 2.4, ask: 2.6, volume: 100 }],
    },
  };
}

// Minimal Durable Object binding so armDriver()/driverStub() are no-ops.
const DO_STUB = {
  idFromName: () => "id",
  get: () => ({ fetch: async () => new Response("{}", { status: 200 }) }),
};

function baseEnv() {
  return {
    LOADER_TOKEN: "sekrit",
    ETL_SCHEDULER: DO_STUB,
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

function makeFetch(fail?: Set<string>) {
  const captures: Array<{ url: string; body: string }> = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if ((init && init.method) === "POST") {
      captures.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    const symbol = decodeURIComponent(url.split("/options/")[1].split(".")[0]);
    if (fail && fail.has(symbol)) return new Response("Forbidden", { status: 403 });
    return new Response(JSON.stringify(cboePayload(symbol)), { status: 200 });
  };
  return { stub, captures };
}

function runRequest(symbols: unknown, token = "sekrit") {
  return new Request("https://x.example/run", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ symbols }),
  });
}

describe("index.js one-shot /run", () => {
  it("publishes the batch in-process and returns the run result", async () => {
    const { stub, captures } = makeFetch();
    vi.stubGlobal("fetch", stub);
    try {
      const res = await worker.fetch(runRequest(["AAPL", "MSFT"]), baseEnv(), { waitUntil: () => {} });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { run: { run_id: string; status: string; successful_symbols: number } };
      expect(body.run.status).toBe("complete");
      expect(body.run.successful_symbols).toBe(2);
      expect(body.run.run_id).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }

    // Both symbols' contracts + underlyings were published to the Pipeline.
    const contracts = captures.filter((c) => c.url === CONTRACTS_URL).flatMap((c) => JSON.parse(c.body));
    expect(contracts).toHaveLength(2);
    const underlyings = captures.filter((c) => c.url === UNDERLYINGS_URL).map((c) => JSON.parse(c.body)[0].symbol);
    expect(underlyings.sort()).toEqual(["AAPL", "MSFT"]);
  });

  it("returns 502 when a symbol fails, with the failure captured", async () => {
    const { stub } = makeFetch(new Set(["NVR"]));
    vi.stubGlobal("fetch", stub);
    try {
      const res = await worker.fetch(runRequest(["AAPL", "NVR"]), baseEnv(), { waitUntil: () => {} });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { run: { status: string; failed_symbols: number } };
      expect(body.run.status).toBe("failed");
      expect(body.run.failed_symbols).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects unauthenticated /run with 401", async () => {
    const res = await worker.fetch(runRequest(["AAPL"], "wrong"), baseEnv(), { waitUntil: () => {} });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body with 400", async () => {
    const bad = new Request("https://x.example/run", {
      method: "POST",
      headers: { authorization: "Bearer sekrit", "content-type": "application/json" },
      body: "not-json",
    });
    const res = await worker.fetch(bad, baseEnv(), { waitUntil: () => {} });
    expect(res.status).toBe(400);
  });
});

describe("index.js /jobs routing", () => {
  it("forwards read-only GET /jobs to the DO", async () => {
    const res = await worker.fetch(new Request("https://x.example/jobs"), baseEnv(), { waitUntil: () => {} });
    expect(res.status).toBe(200);
  });

  it("forwards GET /jobs/{id} to the DO", async () => {
    const res = await worker.fetch(new Request("https://x.example/jobs/cboe-options"), baseEnv(), { waitUntil: () => {} });
    expect(res.status).toBe(200);
  });

  it("requires auth for /jobs/{id}/trigger", async () => {
    const unauth = await worker.fetch(
      new Request("https://x.example/jobs/ohlc-daily/trigger"),
      baseEnv(),
      { waitUntil: () => {} },
    );
    expect(unauth.status).toBe(401);

    const auth = await worker.fetch(
      new Request("https://x.example/jobs/ohlc-daily/trigger", {
        headers: { authorization: "Bearer sekrit" },
      }),
      baseEnv(),
      { waitUntil: () => {} },
    );
    expect(auth.status).toBe(200);
  });
});
