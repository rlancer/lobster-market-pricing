import { describe, expect, it, vi } from "vitest";
import {
  CONTRACT_FIELDS,
  LoaderEnv,
  normalizeContract,
  normalizeSymbols,
  occFields,
  runSymbols,
} from "./run-symbols";

const RUNS_URL = "https://runs.example";
const CONTRACTS_URL = "https://contracts.example";
const UNDERLYINGS_URL = "https://underlyings.example";
const ERRORS_URL = "https://errors.example";

const FIXED_NOW = new Date("2026-08-07T15:00:00.000Z");
const FIXED_RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function cboePayload(symbol: string) {
  return {
    data: {
      current_price: 100,
      options: [
        {
          option: `${symbol}250117C00220000`,
          last: 2.5,
          bid: 2.4,
          ask: 2.6,
          volume: 100,
          open_interest: 500,
          implied_vol: 0.3,
          delta: 0.5,
          gamma: 0.01,
          theta: -0.05,
          vega: 1.0,
          rho: 0.01,
          in_the_money: true,
          theo: 2.5,
          bid_size: 5,
          ask_size: 7,
        },
        {
          option: `${symbol}260619P00150000`,
          last: 1.25,
          bid: 1.2,
          ask: 1.3,
          volume: 50,
          open_interest: 200,
          implied_vol: 0.35,
          delta: -0.4,
          gamma: 0.02,
          theta: -0.03,
          vega: 0.9,
          rho: -0.01,
          in_the_money: false,
          theo: 1.25,
          bid_size: 3,
          ask_size: 6,
        },
        {
          option: `${symbol}260619C00500000`,
          last: 4.0,
          bid: 3.9,
          ask: 4.1,
          volume: 250,
          open_interest: 800,
          implied_vol: 0.2,
          delta: 0.7,
          gamma: 0.015,
          theta: -0.08,
          vega: 1.1,
          rho: 0.02,
          in_the_money: true,
          theo: 4.0,
          bid_size: 8,
          ask_size: 10,
        },
      ],
    },
  };
}

interface Capture {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function makeStub(fail?: Set<string>) {
  const captures: Capture[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init && init.method) || "GET";
    const headers = (init && init.headers ? init.headers : {}) as Record<string, string>;
    if (method === "POST") {
      const body = typeof init?.body === "string" ? init.body : JSON.stringify(init?.body);
      captures.push({ url, body, headers });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const symbol = decodeURIComponent(url.split("/options/")[1].split(".")[0]);
    if (fail && fail.has(symbol)) {
      return new Response("Forbidden", { status: 403 });
    }
    return new Response(JSON.stringify(cboePayload(symbol)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { stub, captures };
}

function bucket(captures: Capture[], url: string): string[] {
  return captures.filter((c) => c.url === url).map((c) => c.body);
}

const SYMBOLS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM"];

function baseEnv(overrides: Partial<LoaderEnv> = {}): LoaderEnv {
  return {
    PIPELINE_RUNS_URL: RUNS_URL,
    PIPELINE_CONTRACTS_URL: CONTRACTS_URL,
    PIPELINE_UNDERLYINGS_URL: UNDERLYINGS_URL,
    PIPELINE_ERRORS_URL: ERRORS_URL,
    PIPELINE_AUTH_TOKEN: "token",
    MAX_BATCH_RECORDS: 5,
    SYMBOL_DELAY_SECONDS: 0,
    now: () => FIXED_NOW,
    runId: () => FIXED_RUN_ID,
    ...overrides,
  };
}

async function captureRun(symbols: string[], env: LoaderEnv) {
  const { stub, captures } = makeStub();
  vi.stubGlobal("fetch", stub);
  try {
    const result = await runSymbols(symbols, env);
    return { result, captures };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("runSymbols", () => {
  it("publishes every symbol once with byte-identical output at C=1 and C=8", async () => {
    const c1 = await captureRun(SYMBOLS, baseEnv({ SYMBOL_CONCURRENCY: 1 }));
    const c8 = await captureRun(SYMBOLS, baseEnv({ SYMBOL_CONCURRENCY: 8 }));

    // Determinism: identical byte stream on every pipeline endpoint regardless
    // of concurrency (same run_id/clock injected, so output is byte-identical).
    for (const url of [RUNS_URL, CONTRACTS_URL, UNDERLYINGS_URL, ERRORS_URL]) {
      expect(bucket(c8.captures, url)).toEqual(bucket(c1.captures, url));
    }

    // Every symbol's underlying published exactly once, in input order.
    const underlyings = bucket(c1.captures, UNDERLYINGS_URL).map((b) => JSON.parse(b)[0].symbol);
    expect(underlyings).toEqual(SYMBOLS);

    // Run record posted twice: running + final.
    expect(bucket(c1.captures, RUNS_URL)).toHaveLength(2);

    // Contracts chunked (MAX_BATCH_RECORDS=5) with no record lost/duplicated.
    const contractBodies = bucket(c1.captures, CONTRACTS_URL);
    const records = contractBodies.flatMap((b) => JSON.parse(b));
    expect(records).toHaveLength(SYMBOLS.length * 3);
    expect(contractBodies.length).toBeGreaterThan(1); // chunking actually split

    // Pipeline POSTs carry the loader User-Agent and idempotency keys.
    const headers = c1.captures[0].headers;
    expect(headers["user-agent"]).toBe("cboe-to-r2/0.2");
    const contractKeys = c1.captures
      .filter((c) => c.url === CONTRACTS_URL)
      .map((c) => c.headers["idempotency-key"]);
    expect(contractKeys).toEqual(
      Array.from({ length: contractKeys.length }, (_, i) => `${FIXED_RUN_ID}:PIPELINE_CONTRACTS_URL:${i + 1}`),
    );

    expect(c1.result.run.status).toBe("complete");
    expect(c1.result.failures).toEqual([]);
  });

  it("parses OCC symbols and normalizes contract field shape", () => {
    const callFields = occFields({ option: "AAPL250117C00220000" });
    expect(callFields.expiration).toBe("2025-01-17");
    expect(callFields.optionType).toBe("call");
    expect(callFields.strike).toBe(220);

    const putFields = occFields({ option: "BRK.B260619P00150000" });
    expect(putFields.expiration).toBe("2026-06-19");
    expect(putFields.optionType).toBe("put");
    expect(putFields.strike).toBe(150);

    const contract = normalizeContract(
      { option: "AAPL250117C00220000", last: "3.5", volume: "100", in_the_money: "true" },
      "AAPL",
      "run1",
      "2026-08-07",
      "t0",
    );
    expect(contract.expiration).toBe("2025-01-17");
    expect(contract.type).toBe("call");
    expect(contract.strike).toBe(220);
    expect(contract.last).toBe(3.5);
    expect(contract.volume).toBe(100);
    expect(contract.in_the_money).toBe(true);
    expect(contract.run_id).toBe("run1");
    expect(contract.as_of_date).toBe("2026-08-07");
    expect(Object.keys(contract)).toEqual([...CONTRACT_FIELDS]);
  });

  it("captures a failing symbol and publishes nothing for it", async () => {
    const { stub, captures } = makeStub(new Set(["NVR"]));
    vi.stubGlobal("fetch", stub);
    let result;
    try {
      result = await runSymbols(["AAPL", "NVR", "MSFT"], baseEnv({ SYMBOL_CONCURRENCY: 3 }));
    } finally {
      vi.unstubAllGlobals();
    }

    expect(result.run.status).toBe("failed");
    expect(result.run.failed_symbols).toBe(1);
    expect(result.run.successful_symbols).toBe(2);
    expect(result.failures.map((f) => f.symbol)).toEqual(["NVR"]);

    const errorRecords = bucket(captures, ERRORS_URL).flatMap((b) => JSON.parse(b));
    expect(errorRecords).toHaveLength(1);
    expect(errorRecords[0].symbol).toBe("NVR");
    expect(errorRecords[0].status).toBe("unavailable");
    expect(errorRecords[0].run_id).toBe(FIXED_RUN_ID);

    // Only the two successful symbols publish underlyings; NVR publishes none.
    const underlyings = bucket(captures, UNDERLYINGS_URL)
      .map((b) => JSON.parse(b)[0].symbol)
      .sort();
    expect(underlyings).toEqual(["AAPL", "MSFT"]);
  });

  it("normalizes and de-duplicates symbols", () => {
    expect(normalizeSymbols([" aapl ", "AAPL", "MSFT", "msft"])).toEqual(["AAPL", "MSFT"]);
    expect(() => normalizeSymbols([])).toThrow();
    expect(() => normalizeSymbols(["NOT VALID!"])).toThrow();
  });
});
