import { describe, expect, it, vi } from "vitest";
import type { KalshiMarketRow } from "./kalshi.js";
import {
  acceptParlayQuote,
  decisionFromTwoWay,
  runKalshiParlayExecutorPass,
  splitOpenSportsRows,
} from "./kalshi-parlay-executor.js";
import type { MveSelectedLeg } from "./kalshi-mve.js";

async function generateTestPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

const SAME_GAME_LEGS: MveSelectedLeg[] = [
  { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", side: "yes" },
  { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", side: "yes" },
];

function combo(overrides: Partial<KalshiMarketRow> = {}): KalshiMarketRow {
  return {
    series_ticker: "KXMVE",
    market_ticker: "KXMVECROSSCATEGORY-HENRYJACK",
    event_ticker: null,
    title: "Henry 110+ AND Jackson 40+",
    yes_subtitle: null,
    theme: "sports",
    category: "mve|KXMVECROSSCATEGORY-SHARD1-R|yes:KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110,yes:KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40",
    status: "active",
    market_type: "multivariate",
    yes_bid: 0,
    yes_ask: 0,
    yes_last: 0,
    no_bid: 0,
    no_ask: 0,
    volume: 0,
    volume_24h: 0,
    open_interest: 0,
    liquidity: null,
    floor_strike: null,
    close_time: "2026-09-14T00:00:00Z",
    expiration_time: null,
    related_symbol: null,
    source: "kalshi",
    ...overrides,
  };
}

function leg(ticker: string, bid: number, ask: number): KalshiMarketRow {
  return {
    series_ticker: "KXNFLRSHYDS",
    market_ticker: ticker,
    event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
    title: ticker,
    yes_subtitle: null,
    theme: "sports",
    category: null,
    status: "active",
    market_type: "binary",
    yes_bid: bid,
    yes_ask: ask,
    yes_last: (bid + ask) / 2,
    no_bid: 1 - ask,
    no_ask: 1 - bid,
    volume: 10,
    volume_24h: 2,
    open_interest: 5,
    liquidity: null,
    floor_strike: null,
    close_time: "2026-09-14T00:00:00Z",
    expiration_time: null,
    related_symbol: null,
    source: "kalshi",
  };
}

describe("splitOpenSportsRows", () => {
  it("keeps MVE combos separate from selected legs", () => {
    const henry = combo();
    const a = leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.39, 0.41);
    const { combos, legs } = splitOpenSportsRows([henry, a]);
    expect(combos.map((row) => row.market_ticker)).toEqual([henry.market_ticker]);
    expect(legs.map((row) => row.market_ticker)).toEqual([a.market_ticker]);
  });
});

describe("decisionFromTwoWay", () => {
  it("would buy a same-side two-way sitting on independence", () => {
    const decision = decisionFromTwoWay(
      { market_ticker: "HENRYJACK", corr_room: 0.204, p: 0.40, q: 0.49 },
      SAME_GAME_LEGS,
      {
        yes_bid: 0.18,
        yes_ask: 0.21,
        no_bid: 0.79,
        no_ask: 0.82,
        mid: 0.195,
        quote_id: "q1",
      },
    );
    expect(decision.ok).toBe(true);
    expect(decision.action).toBe("buy_yes");
  });
});

describe("acceptParlayQuote", () => {
  it("throws unless both execute and live flags are set", async () => {
    await expect(acceptParlayQuote({ KALSHI_PARLAY_EXECUTE: "1" }, "rfq", "q")).rejects.toThrow(/refuses accept/);
    await expect(acceptParlayQuote({ KALSHI_PARLAY_LIVE: "1" }, "rfq", "q")).rejects.toThrow(/refuses accept/);
  });
});

describe("runKalshiParlayExecutorPass", () => {
  it("no-ops when execute is off", async () => {
    const pass = await runKalshiParlayExecutorPass({});
    expect(pass.attempted).toBe(0);
    expect(pass.accepted).toBe(0);
    expect(pass.idle_reason).toBe("execute_off");
  });

  it("records no_api_keys without fetching markets", async () => {
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const pass = await runKalshiParlayExecutorPass({ KALSHI_PARLAY_EXECUTE: "1" });
      expect(pass.idle_reason).toBe("no_api_keys");
      expect(pass.attempted).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(warns.some((line) => line.includes("no API keys"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("records no_targets when same-game stacks have no tradable leg mids", async () => {
    const pem = await generateTestPem();
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("mve_filter=only")) {
        return new Response(JSON.stringify({
          markets: [{
            ticker: "KXMVECROSSCATEGORY-HENRYJACK",
            event_ticker: "KXMVECROSSCATEGORY-HENRYJACK",
            series_ticker: "KXMVE",
            title: "Henry 110+ AND Jackson 40+",
            category: "Sports",
            status: "active",
            market_type: "binary",
            mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
            mve_selected_legs: SAME_GAME_LEGS,
            yes_bid_dollars: "0.00",
            yes_ask_dollars: "0.00",
            last_price_dollars: "0.00",
            volume_fp: "0",
            close_time: "2026-09-14T00:00:00Z",
          }],
          cursor: "",
        }), { status: 200 });
      }
      if (url.includes("tickers=")) {
        return new Response(JSON.stringify({
          markets: [
            {
              ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110",
              event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
              series_ticker: "KXNFLRSHYDS",
              title: "Henry 110+",
              status: "active",
              yes_bid_dollars: "0.00",
              yes_ask_dollars: "0.00",
              last_price_dollars: "0.00",
              volume_fp: "0",
              close_time: "2026-09-14T00:00:00Z",
            },
            {
              ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40",
              event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
              series_ticker: "KXNFLRSHYDS",
              title: "Jackson 40+",
              status: "active",
              yes_bid_dollars: "0.00",
              yes_ask_dollars: "0.00",
              last_price_dollars: "0.00",
              volume_fp: "0",
              close_time: "2026-09-14T00:00:00Z",
            },
          ],
        }), { status: 200 });
      }
      return new Response("unexpected " + url, { status: 500 });
    });
    try {
      const pass = await runKalshiParlayExecutorPass({
        KALSHI_PARLAY_EXECUTE: "1",
        KALSHI_ACCESS_KEY_ID: "key",
        KALSHI_PRIVATE_KEY_PEM: pem,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        HTTP_RETRIES: 0,
      });
      expect(pass.idle_reason).toBe("no_targets");
      expect(pass.attempted).toBe(0);
      expect(pass.open_combos).toBe(1);
      expect(pass.open_legs).toBe(2);
      expect(pass.combo_legs).toBe(1);
      expect(pass.same_game_two_leg).toBe(1);
      expect(pass.missing_leg_mids).toBe(1);
      expect(warns.some((line) => line.includes("skip no_targets"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("dry-run solicits, logs would_accept, deletes, and never accepts", async () => {
    const pem = await generateTestPem();
    const calls: Array<{ url: string; method: string }> = [];
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ url, method });
      if (url.includes("mve_filter=only")) {
        return new Response(JSON.stringify({
          markets: [{
            ticker: "KXMVECROSSCATEGORY-HENRYJACK",
            event_ticker: "KXMVECROSSCATEGORY-HENRYJACK",
            series_ticker: "KXMVE",
            title: "Henry 110+ AND Jackson 40+",
            category: "Sports",
            status: "active",
            market_type: "binary",
            mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
            mve_selected_legs: SAME_GAME_LEGS,
            yes_bid_dollars: "0.00",
            yes_ask_dollars: "0.00",
            last_price_dollars: "0.00",
            volume_fp: "0",
            close_time: "2026-09-14T00:00:00Z",
          }],
          cursor: "",
        }), { status: 200 });
      }
      if (url.includes("tickers=")) {
        return new Response(JSON.stringify({
          markets: [
            {
              ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110",
              event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
              series_ticker: "KXNFLRSHYDS",
              title: "Henry 110+",
              status: "active",
              yes_bid_dollars: "0.39",
              yes_ask_dollars: "0.41",
              last_price_dollars: "0.40",
              volume_fp: "100",
              close_time: "2026-09-14T00:00:00Z",
            },
            {
              ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40",
              event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
              series_ticker: "KXNFLRSHYDS",
              title: "Jackson 40+",
              status: "active",
              yes_bid_dollars: "0.48",
              yes_ask_dollars: "0.50",
              last_price_dollars: "0.49",
              volume_fp: "80",
              close_time: "2026-09-14T00:00:00Z",
            },
          ],
        }), { status: 200 });
      }
      if (url.includes("/communications/rfqs") && method === "GET") {
        return new Response(JSON.stringify({ rfqs: [] }), { status: 200 });
      }
      if (url.endsWith("/communications/rfqs") && method === "POST") {
        return new Response(JSON.stringify({ id: "rfq-exec" }), { status: 201 });
      }
      if (url.includes("/communications/quotes") && method === "GET") {
        return new Response(JSON.stringify({
          quotes: [{
            id: "q-exec",
            status: "open",
            yes_bid_dollars: "0.18",
            no_bid_dollars: "0.79",
          }],
        }), { status: 200 });
      }
      if (url.includes("/communications/rfqs/rfq-exec") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected " + method + " " + url, { status: 500 });
    });
    try {
      const pass = await runKalshiParlayExecutorPass({
        KALSHI_PARLAY_EXECUTE: "1",
        KALSHI_ACCESS_KEY_ID: "key",
        KALSHI_PRIVATE_KEY_PEM: pem,
        KALSHI_RFQ_WAIT_MS: 0,
        KALSHI_RFQ_POLL_MS: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        HTTP_RETRIES: 0,
      });
      expect(pass.attempted).toBe(1);
      expect(pass.would_accept).toBe(1);
      expect(pass.accepted).toBe(0);
      expect(pass.idle_reason).toBeNull();
      expect(pass.combo_legs).toBe(1);
      expect(pass.same_game_two_leg).toBe(1);
      expect(pass.decisions[0]?.quote_id).toBe("q-exec");
      expect(calls.some((c) => c.method === "DELETE")).toBe(true);
      expect(calls.some((c) => /accept/i.test(c.url))).toBe(false);
      expect(calls.some((c) => /confirm/i.test(c.url))).toBe(false);
      expect(warns.some((line) => line.includes("would_accept"))).toBe(true);
      expect(warns.some((line) => line.includes("deleted rfq"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("live accept hits /accept yes and does not confirm", async () => {
    const pem = await generateTestPem();
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ url, method, body: init?.body ? String(init.body) : null });
      if (url.includes("mve_filter=only")) {
        return new Response(JSON.stringify({
          markets: [{
            ticker: "KXMVECROSSCATEGORY-HENRYJACK",
            series_ticker: "KXMVE",
            title: "Henry 110+ AND Jackson 40+",
            status: "active",
            mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
            mve_selected_legs: SAME_GAME_LEGS,
            yes_bid_dollars: "0.00",
            yes_ask_dollars: "0.00",
            last_price_dollars: "0.00",
            volume_fp: "0",
            close_time: "2026-09-14T00:00:00Z",
          }],
          cursor: "",
        }), { status: 200 });
      }
      if (url.includes("tickers=")) {
        return new Response(JSON.stringify({
          markets: [
            {
              ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110",
              event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
              series_ticker: "KXNFLRSHYDS",
              title: "Henry 110+",
              status: "active",
              yes_bid_dollars: "0.39",
              yes_ask_dollars: "0.41",
              last_price_dollars: "0.40",
              volume_fp: "100",
              close_time: "2026-09-14T00:00:00Z",
            },
            {
              ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40",
              event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
              series_ticker: "KXNFLRSHYDS",
              title: "Jackson 40+",
              status: "active",
              yes_bid_dollars: "0.48",
              yes_ask_dollars: "0.50",
              last_price_dollars: "0.49",
              volume_fp: "80",
              close_time: "2026-09-14T00:00:00Z",
            },
          ],
        }), { status: 200 });
      }
      if (url.includes("/communications/rfqs") && method === "GET") {
        return new Response(JSON.stringify({ rfqs: [] }), { status: 200 });
      }
      if (url.endsWith("/communications/rfqs") && method === "POST") {
        return new Response(JSON.stringify({ id: "rfq-live" }), { status: 201 });
      }
      if (url.includes("/communications/quotes") && method === "GET") {
        return new Response(JSON.stringify({
          quotes: [{
            id: "q-live",
            status: "open",
            yes_bid_dollars: "0.18",
            no_bid_dollars: "0.79",
          }],
        }), { status: 200 });
      }
      if (url.includes("/accept") && method === "PUT") {
        return new Response(null, { status: 204 });
      }
      if (url.includes("/communications/rfqs/rfq-live") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected " + method + " " + url, { status: 500 });
    });
    try {
      const pass = await runKalshiParlayExecutorPass({
        KALSHI_PARLAY_EXECUTE: "1",
        KALSHI_PARLAY_LIVE: "1",
        KALSHI_ACCESS_KEY_ID: "key",
        KALSHI_PRIVATE_KEY_PEM: pem,
        KALSHI_RFQ_WAIT_MS: 0,
        KALSHI_RFQ_POLL_MS: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        HTTP_RETRIES: 0,
      });
      expect(pass.accepted).toBe(1);
      const accept = calls.find((c) => /accept/i.test(c.url));
      expect(accept?.method).toBe("PUT");
      expect(accept?.body).toContain("yes");
      const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/communications/rfqs"));
      expect(create?.body).toContain('"contracts_fp":"10.00"');
      expect(calls.some((c) => /confirm/i.test(c.url))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("live stops after one $10 fill even when two quotes would pass", async () => {
    const pem = await generateTestPem();
    const extraLegs: MveSelectedLeg[] = [
      { event_ticker: "KXNFLRSHYDS-26SEP13ATLPIT", market_ticker: "KXNFLRSHYDS-26SEP13ATLPIT-ATLBJAE6-70", side: "yes" },
      { event_ticker: "KXNFLRSHYDS-26SEP13ATLPIT", market_ticker: "KXNFLRSHYDS-26SEP13ATLPIT-PITNAJEE22-50", side: "yes" },
    ];
    const calls: Array<{ url: string; method: string }> = [];
    let rfqSeq = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ url, method });
      if (url.includes("mve_filter=only")) {
        return new Response(JSON.stringify({
          markets: [
            {
              ticker: "KXMVECROSSCATEGORY-HENRYJACK",
              series_ticker: "KXMVE",
              title: "Henry 110+ AND Jackson 40+",
              status: "active",
              mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
              mve_selected_legs: SAME_GAME_LEGS,
              yes_bid_dollars: "0.00",
              yes_ask_dollars: "0.00",
              last_price_dollars: "0.00",
              volume_fp: "0",
              close_time: "2026-09-14T00:00:00Z",
            },
            {
              ticker: "KXMVECROSSCATEGORY-BIJANNAJEE",
              series_ticker: "KXMVE",
              title: "Bijan 70+ AND Najee 50+",
              status: "active",
              mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
              mve_selected_legs: extraLegs,
              yes_bid_dollars: "0.00",
              yes_ask_dollars: "0.00",
              last_price_dollars: "0.00",
              volume_fp: "0",
              close_time: "2026-09-14T00:00:00Z",
            },
          ],
          cursor: "",
        }), { status: 200 });
      }
      if (url.includes("tickers=")) {
        return new Response(JSON.stringify({
          markets: [
            {
              ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110",
              event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
              series_ticker: "KXNFLRSHYDS",
              title: "Henry 110+",
              status: "active",
              yes_bid_dollars: "0.39",
              yes_ask_dollars: "0.41",
              last_price_dollars: "0.40",
              volume_fp: "100",
              close_time: "2026-09-14T00:00:00Z",
            },
            {
              ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40",
              event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
              series_ticker: "KXNFLRSHYDS",
              title: "Jackson 40+",
              status: "active",
              yes_bid_dollars: "0.48",
              yes_ask_dollars: "0.50",
              last_price_dollars: "0.49",
              volume_fp: "80",
              close_time: "2026-09-14T00:00:00Z",
            },
            {
              ticker: "KXNFLRSHYDS-26SEP13ATLPIT-ATLBJAE6-70",
              event_ticker: "KXNFLRSHYDS-26SEP13ATLPIT",
              series_ticker: "KXNFLRSHYDS",
              title: "Bijan 70+",
              status: "active",
              yes_bid_dollars: "0.39",
              yes_ask_dollars: "0.41",
              last_price_dollars: "0.40",
              volume_fp: "100",
              close_time: "2026-09-14T00:00:00Z",
            },
            {
              ticker: "KXNFLRSHYDS-26SEP13ATLPIT-PITNAJEE22-50",
              event_ticker: "KXNFLRSHYDS-26SEP13ATLPIT",
              series_ticker: "KXNFLRSHYDS",
              title: "Najee 50+",
              status: "active",
              yes_bid_dollars: "0.48",
              yes_ask_dollars: "0.50",
              last_price_dollars: "0.49",
              volume_fp: "80",
              close_time: "2026-09-14T00:00:00Z",
            },
          ],
        }), { status: 200 });
      }
      if (url.includes("/communications/rfqs") && method === "GET") {
        return new Response(JSON.stringify({ rfqs: [] }), { status: 200 });
      }
      if (url.endsWith("/communications/rfqs") && method === "POST") {
        rfqSeq += 1;
        return new Response(JSON.stringify({ id: `rfq-${rfqSeq}` }), { status: 201 });
      }
      if (url.includes("/communications/quotes") && method === "GET") {
        return new Response(JSON.stringify({
          quotes: [{
            id: `q-${rfqSeq}`,
            status: "open",
            yes_bid_dollars: "0.18",
            no_bid_dollars: "0.79",
          }],
        }), { status: 200 });
      }
      if (url.includes("/accept") && method === "PUT") {
        return new Response(null, { status: 204 });
      }
      if (url.includes("/communications/rfqs/") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected " + method + " " + url, { status: 500 });
    });
    try {
      const pass = await runKalshiParlayExecutorPass({
        KALSHI_PARLAY_EXECUTE: "1",
        KALSHI_PARLAY_LIVE: "1",
        KALSHI_ACCESS_KEY_ID: "key",
        KALSHI_PRIVATE_KEY_PEM: pem,
        KALSHI_RFQ_WAIT_MS: 0,
        KALSHI_RFQ_POLL_MS: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        HTTP_RETRIES: 0,
      });
      expect(pass.same_game_two_leg).toBe(2);
      expect(pass.attempted).toBe(1);
      expect(pass.accepted).toBe(1);
      expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/communications/rfqs")).length).toBe(1);
      expect(calls.filter((c) => /accept/i.test(c.url)).length).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("dry-run skips a Fréchet-priced tape, deletes the RFQ, and never accepts", async () => {
    const pem = await generateTestPem();
    const calls: Array<{ url: string; method: string }> = [];
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ url, method });
      if (url.includes("mve_filter=only")) {
        return new Response(JSON.stringify({
          markets: [{
            ticker: "KXMVECROSSCATEGORY-HENRYJACK",
            event_ticker: "KXMVECROSSCATEGORY-HENRYJACK",
            series_ticker: "KXMVE",
            title: "Henry 110+ AND Jackson 40+",
            category: "Sports",
            status: "active",
            market_type: "binary",
            mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
            mve_selected_legs: SAME_GAME_LEGS,
            yes_bid_dollars: "0.00",
            yes_ask_dollars: "0.00",
            last_price_dollars: "0.00",
            volume_fp: "0",
            close_time: "2026-09-14T00:00:00Z",
          }],
          cursor: "",
        }), { status: 200 });
      }
      if (url.includes("tickers=")) {
        return new Response(JSON.stringify({
          markets: [
            {
              ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110",
              event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
              series_ticker: "KXNFLRSHYDS",
              title: "Henry 110+",
              status: "active",
              yes_bid_dollars: "0.39",
              yes_ask_dollars: "0.41",
              last_price_dollars: "0.40",
              volume_fp: "100",
              close_time: "2026-09-14T00:00:00Z",
            },
            {
              ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40",
              event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
              series_ticker: "KXNFLRSHYDS",
              title: "Jackson 40+",
              status: "active",
              yes_bid_dollars: "0.48",
              yes_ask_dollars: "0.50",
              last_price_dollars: "0.49",
              volume_fp: "80",
              close_time: "2026-09-14T00:00:00Z",
            },
          ],
        }), { status: 200 });
      }
      if (url.includes("/communications/rfqs") && method === "GET") {
        return new Response(JSON.stringify({ rfqs: [] }), { status: 200 });
      }
      if (url.endsWith("/communications/rfqs") && method === "POST") {
        return new Response(JSON.stringify({ id: "rfq-skip" }), { status: 201 });
      }
      if (url.includes("/communications/quotes") && method === "GET") {
        return new Response(JSON.stringify({
          quotes: [{
            id: "q-skip",
            status: "open",
            yes_bid_dollars: "0.38",
            no_bid_dollars: "0.59",
          }],
        }), { status: 200 });
      }
      if (url.includes("/communications/rfqs/rfq-skip") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected " + method + " " + url, { status: 500 });
    });
    try {
      const pass = await runKalshiParlayExecutorPass({
        KALSHI_PARLAY_EXECUTE: "1",
        KALSHI_ACCESS_KEY_ID: "key",
        KALSHI_PRIVATE_KEY_PEM: pem,
        KALSHI_RFQ_WAIT_MS: 0,
        KALSHI_RFQ_POLL_MS: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        HTTP_RETRIES: 0,
      });
      expect(pass.attempted).toBe(1);
      expect(pass.would_accept).toBe(0);
      expect(pass.accepted).toBe(0);
      expect(pass.decisions[0]?.filter?.reasons).toEqual(expect.arrayContaining(["ask_vs_indep", "phi"]));
      expect(calls.some((c) => c.method === "DELETE")).toBe(true);
      expect(calls.some((c) => /accept/i.test(c.url))).toBe(false);
      expect(calls.some((c) => /confirm/i.test(c.url))).toBe(false);
      expect(warns.some((line) => line.includes("skip") && line.includes("ask_vs_indep"))).toBe(true);
      expect(warns.some((line) => line.includes("deleted rfq"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
