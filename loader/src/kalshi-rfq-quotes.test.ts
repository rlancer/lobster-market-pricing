import { describe, expect, it, vi } from "vitest";
import type { KalshiMarketRow } from "./kalshi.js";
import { publishKalshiSeries } from "./kalshi.js";
import {
  applyRfqTwoWay,
  comboHasTwoSidedBook,
  KALSHI_RFQ_SOURCE,
  pickRfqProbeTargets,
  probeKalshiRfqQuotes,
  rfqContracts,
  rfqProbeEnabled,
  rfqProbeUniverseStats,
  twoWayFromRfqQuotes,
} from "./kalshi-rfq-quotes.js";
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

const SAME_GAME_LEGS: MveSelectedLeg[] = [
  { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", side: "yes" },
  { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", side: "yes" },
];

const CROSS_GAME_LEGS: MveSelectedLeg[] = [
  { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-KC", side: "yes" },
  { event_ticker: "KXNFLGAME-26SEP13BUF", market_ticker: "KXNFLGAME-26SEP13BUF-BUF", side: "yes" },
];

describe("RFQ contract size", () => {
  it("defaults to 10 contracts ($10 notional) and caps at PARLAY_MAX_CONTRACTS", () => {
    expect(rfqContracts({})).toBe(10);
    expect(rfqContracts({ KALSHI_RFQ_CONTRACTS: 1 })).toBe(1);
    expect(rfqContracts({ KALSHI_RFQ_CONTRACTS: "25" })).toBe(10);
  });
});

describe("RFQ quote mapping", () => {
  it("maps a single-maker two-way onto yes bid/ask", () => {
    const twoWay = twoWayFromRfqQuotes([{
      id: "q-1",
      status: "open",
      yes_bid_dollars: "0.18",
      no_bid_dollars: "0.79",
    }]);
    expect(twoWay).not.toBeNull();
    expect(twoWay!.yes_bid).toBeCloseTo(0.18);
    expect(twoWay!.yes_ask).toBeCloseTo(0.21);
    expect(twoWay!.no_bid).toBeCloseTo(0.79);
    expect(twoWay!.mid).toBeCloseTo(0.195);
    expect(twoWay!.quote_id).toBe("q-1");
  });

  it("prefers the tightest single-maker two-way over a mixed TOB", () => {
    const twoWay = twoWayFromRfqQuotes([
      { status: "open", yes_bid_dollars: "0.30", no_bid_dollars: "0.40" },
      { status: "open", yes_bid_dollars: "0.10", no_bid_dollars: "0.85" },
    ]);
    expect(twoWay!.yes_bid).toBeCloseTo(0.10);
    expect(twoWay!.yes_ask).toBeCloseTo(0.15);
  });

  it("ignores cancelled quotes and one-sided zeros", () => {
    expect(twoWayFromRfqQuotes([
      { status: "cancelled", yes_bid_dollars: "0.50", no_bid_dollars: "0.40" },
      { status: "open", yes_bid_dollars: "0.00", no_bid_dollars: "0.00" },
    ])).toBeNull();
  });

  it("applies the two-way with source=kalshi_rfq", () => {
    const row = applyRfqTwoWay(combo(), {
      yes_bid: 0.18,
      yes_ask: 0.21,
      no_bid: 0.79,
      no_ask: 0.82,
      mid: 0.195,
      quote_id: "q-apply",
    });
    expect(row.source).toBe(KALSHI_RFQ_SOURCE);
    expect(row.yes_bid).toBeCloseTo(0.18);
    expect(comboHasTwoSidedBook(row)).toBe(true);
    expect(comboHasTwoSidedBook(combo())).toBe(false);
  });
});

describe("RFQ probe target ranking", () => {
  it("prefers same-game empty books by corr room, then fills the cap with CLOB two-ways", () => {
    const highRoom = combo({ market_ticker: "HIGH-ROOM" });
    const lowRoom = combo({
      market_ticker: "LOW-ROOM",
      category: "mve|COLL|yes:KXNFLRSHYDS-26SEP13BALIND-A,yes:KXNFLRSHYDS-26SEP13BALIND-B",
    });
    const twoSided = combo({
      market_ticker: "ALREADY-TWO",
      yes_bid: 0.20,
      yes_ask: 0.24,
    });
    const cross = combo({
      market_ticker: "CROSS-GAME",
      category: "mve|COLL|yes:KXNFLGAME-26SEP13KC-KC,yes:KXNFLGAME-26SEP13BUF-BUF",
    });
    const legs = [
      leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.39, 0.41),
      leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0.48, 0.50),
      leg("KXNFLRSHYDS-26SEP13BALIND-A", 0.80, 0.82),
      leg("KXNFLRSHYDS-26SEP13BALIND-B", 0.81, 0.83),
      leg("KXNFLGAME-26SEP13KC-KC", 0.55, 0.57),
      leg("KXNFLGAME-26SEP13BUF-BUF", 0.48, 0.50),
    ];
    const comboLegs = new Map<string, MveSelectedLeg[]>([
      ["HIGH-ROOM", SAME_GAME_LEGS],
      ["LOW-ROOM", [
        { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-A", side: "yes" },
        { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-B", side: "yes" },
      ]],
      ["ALREADY-TWO", SAME_GAME_LEGS],
      ["CROSS-GAME", CROSS_GAME_LEGS],
    ]);
    const preferred = pickRfqProbeTargets(
      [cross, twoSided, lowRoom, highRoom],
      comboLegs,
      legs,
      2,
    );
    expect(preferred.map((t) => t.market_ticker)).toEqual(["HIGH-ROOM", "LOW-ROOM"]);
    expect(preferred[0]!.corr_room).toBeGreaterThan(preferred[1]!.corr_room);

    const filled = pickRfqProbeTargets(
      [cross, twoSided, lowRoom, highRoom],
      comboLegs,
      legs,
      12,
    );
    expect(filled.map((t) => t.market_ticker)).toEqual(["HIGH-ROOM", "LOW-ROOM", "ALREADY-TWO"]);
  });

  it("counts open same-game two-legs separately from missing tradable mids", () => {
    const priced = combo({ market_ticker: "PRICED" });
    const unpriced = combo({ market_ticker: "UNPRICED" });
    const cross = combo({
      market_ticker: "CROSS-GAME",
      category: "mve|COLL|yes:KXNFLGAME-26SEP13KC-KC,yes:KXNFLGAME-26SEP13BUF-BUF",
    });
    const comboLegs = new Map<string, MveSelectedLeg[]>([
      ["PRICED", SAME_GAME_LEGS],
      ["UNPRICED", SAME_GAME_LEGS],
      ["CROSS-GAME", CROSS_GAME_LEGS],
    ]);
    const stats = rfqProbeUniverseStats(
      [priced, unpriced, cross],
      comboLegs,
      [
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.39, 0.41),
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0.48, 0.50),
        leg("KXNFLGAME-26SEP13KC-KC", 0.55, 0.57),
        leg("KXNFLGAME-26SEP13BUF-BUF", 0.48, 0.50),
      ],
    );
    expect(stats).toEqual({
      open_combos: 3,
      open_legs: 4,
      combo_legs: 3,
      two_leg: 3,
      same_game_two_leg: 2,
      cross_game_two_leg: 1,
      missing_leg_mids: 0,
      samples: [
        { market_ticker: "PRICED", n_legs: 2, game_group: "same_game", tape: "sports" },
        { market_ticker: "UNPRICED", n_legs: 2, game_group: "same_game", tape: "sports" },
        { market_ticker: "CROSS-GAME", n_legs: 2, game_group: "cross_game", tape: "sports" },
      ],
    });
    const noMids = rfqProbeUniverseStats(
      [unpriced],
      new Map([["UNPRICED", SAME_GAME_LEGS]]),
      [
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0, 0),
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0, 0),
      ],
    );
    expect(noMids.same_game_two_leg).toBe(1);
    expect(noMids.missing_leg_mids).toBe(1);
    expect(noMids.combo_legs).toBe(1);
  });

  it("samples same-game two-leg books before volume-order n>2 or cross-game", () => {
    const threeLeg = combo({ market_ticker: "NOISE-3" });
    const cross = combo({ market_ticker: "CROSS-GAME" });
    const same = combo({ market_ticker: "VOL0-SAME" });
    const stats = rfqProbeUniverseStats(
      [threeLeg, cross, same],
      new Map<string, MveSelectedLeg[]>([
        ["NOISE-3", [
          { event_ticker: "KXNFLGAME-26SEP13AAA", market_ticker: "KXNFLGAME-26SEP13AAA-A", side: "yes" },
          { event_ticker: "KXNFLGAME-26SEP13BBB", market_ticker: "KXNFLGAME-26SEP13BBB-B", side: "yes" },
          { event_ticker: "KXNFLGAME-26SEP13CCC", market_ticker: "KXNFLGAME-26SEP13CCC-C", side: "yes" },
        ]],
        ["CROSS-GAME", CROSS_GAME_LEGS],
        ["VOL0-SAME", SAME_GAME_LEGS],
      ]),
      [
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.39, 0.41),
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0.48, 0.50),
      ],
    );
    expect(stats.same_game_two_leg).toBe(1);
    expect(stats.samples[0]).toEqual({
      market_ticker: "VOL0-SAME",
      n_legs: 2,
      game_group: "same_game",
      tape: "sports",
    });
  });

  it("uses selected-leg event_ticker for same-game books without an NFL slug", () => {
    const wnbaLegs: MveSelectedLeg[] = [
      { event_ticker: "KXWNBAGAME-2026-09-14-NYL-LAS", market_ticker: "KXWNBAGAME-NYL-WIN", side: "yes" },
      { event_ticker: "KXWNBAGAME-2026-09-14-NYL-LAS", market_ticker: "KXWNBAGAME-LAS-WIN", side: "yes" },
    ];
    const row = combo({ market_ticker: "WNBA-PARLAY" });
    const priced = [
      leg("KXWNBAGAME-NYL-WIN", 0.55, 0.57),
      leg("KXWNBAGAME-LAS-WIN", 0.48, 0.50),
    ];
    const fromApi = pickRfqProbeTargets(
      [row],
      new Map([["WNBA-PARLAY", wnbaLegs]]),
      priced,
      12,
    );
    expect(fromApi).toHaveLength(1);
    const fromCategory = pickRfqProbeTargets(
      [row],
      new Map([["WNBA-PARLAY", wnbaLegs.map((leg) => ({ ...leg, event_ticker: null }))]]),
      priced,
      12,
    );
    expect(fromCategory).toHaveLength(0);
  });
});

describe("RFQ probe HTTP", () => {
  it("is off without explicit enable + auth", () => {
    expect(rfqProbeEnabled({})).toBe(false);
    expect(rfqProbeEnabled({
      KALSHI_ACCESS_KEY_ID: "x",
      KALSHI_PRIVATE_KEY_PEM: "y",
    })).toBe(false);
  });

  it("is off when the parlay executor owns the RFQ slot", () => {
    expect(rfqProbeEnabled({
      KALSHI_ACCESS_KEY_ID: "x",
      KALSHI_PRIVATE_KEY_PEM: "y",
      KALSHI_RFQ_PROBE_ENABLED: "1",
      KALSHI_PARLAY_EXECUTE: "1",
    })).toBe(false);
  });

  it("does not create RFQs when the executor owns the slot", async () => {
    const pem = await generateTestPem();
    const calls: string[] = [];
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("unexpected", { status: 500 });
    });
    try {
      const combos = [combo()];
      const out = await probeKalshiRfqQuotes(
        {
          KALSHI_ACCESS_KEY_ID: "key",
          KALSHI_PRIVATE_KEY_PEM: pem,
          KALSHI_RFQ_PROBE_ENABLED: "1",
          KALSHI_PARLAY_EXECUTE: "1",
        },
        combos,
        new Map([["KXMVECROSSCATEGORY-HENRYJACK", SAME_GAME_LEGS]]),
        [
          leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.39, 0.41),
          leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0.48, 0.50),
        ],
      );
      expect(out).toEqual(combos);
      expect(calls.some((url) => url.includes("/communications"))).toBe(false);
      expect(warns.some((line) => line.includes("parlay executor owns RFQ slot"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("creates an RFQ, maps quotes, cancels, and never accepts", async () => {
    const pem = await generateTestPem();
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      calls.push({ url, method, body: init?.body ? String(init.body) : null });
      if (url.includes("/communications/rfqs") && method === "GET") {
        return new Response(JSON.stringify({ rfqs: [] }), { status: 200 });
      }
      if (url.endsWith("/communications/rfqs") && method === "POST") {
        const body = JSON.parse(String(init?.body || "{}"));
        expect(body.rest_remainder).toBe(false);
        expect(body.contracts_fp).toBe("10.00");
        expect(body.replace_existing).toBe(true);
        return new Response(JSON.stringify({ id: "rfq-1" }), { status: 201 });
      }
      if (url.includes("/communications/quotes") && method === "GET") {
        return new Response(JSON.stringify({
          quotes: [{
            id: "q1",
            rfq_id: "rfq-1",
            status: "open",
            yes_bid_dollars: "0.18",
            no_bid_dollars: "0.79",
          }],
        }), { status: 200 });
      }
      if (url.includes("/communications/rfqs/rfq-1") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected " + method + " " + url, { status: 500 });
    });
    try {
      const out = await probeKalshiRfqQuotes(
        {
          KALSHI_ACCESS_KEY_ID: "key",
          KALSHI_PRIVATE_KEY_PEM: pem,
          KALSHI_RFQ_PROBE_ENABLED: "1",
          KALSHI_RFQ_WAIT_MS: 0,
          KALSHI_RFQ_POLL_MS: 0,
          KALSHI_MIN_REQUEST_GAP_MS: 0,
          HTTP_RETRIES: 0,
        },
        [combo()],
        new Map([["KXMVECROSSCATEGORY-HENRYJACK", SAME_GAME_LEGS]]),
        [
          leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.39, 0.41),
          leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0.48, 0.50),
        ],
      );
      expect(out[0]!.source).toBe(KALSHI_RFQ_SOURCE);
      expect(out[0]!.yes_bid).toBeCloseTo(0.18);
      expect(out[0]!.yes_ask).toBeCloseTo(0.21);
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/communications/rfqs"))).toBe(true);
      expect(calls.some((c) => c.method === "GET" && c.url.includes("rfq_user_filter=self"))).toBe(true);
      expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/rfqs/rfq-1"))).toBe(true);
      expect(calls.some((c) => /accept|confirm/i.test(c.url))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels the RFQ even when quote fetch fails", async () => {
    const pem = await generateTestPem();
    let deleted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/communications/rfqs") && method === "GET") {
        return new Response(JSON.stringify({ rfqs: [] }), { status: 200 });
      }
      if (url.endsWith("/communications/rfqs") && method === "POST") {
        return new Response(JSON.stringify({ id: "rfq-boom" }), { status: 201 });
      }
      if (url.includes("/communications/quotes")) {
        return new Response("nope", { status: 500 });
      }
      if (url.includes("/rfqs/rfq-boom") && method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    });
    try {
      const out = await probeKalshiRfqQuotes(
        {
          KALSHI_ACCESS_KEY_ID: "key",
          KALSHI_PRIVATE_KEY_PEM: pem,
          KALSHI_RFQ_PROBE_ENABLED: "1",
          KALSHI_RFQ_WAIT_MS: 0,
          KALSHI_RFQ_POLL_MS: 0,
          KALSHI_RFQ_POLLS: 1,
          KALSHI_MIN_REQUEST_GAP_MS: 0,
          HTTP_RETRIES: 0,
        },
        [combo()],
        new Map([["KXMVECROSSCATEGORY-HENRYJACK", SAME_GAME_LEGS]]),
        [
          leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.39, 0.41),
          leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0.48, 0.50),
        ],
      );
      expect(deleted).toBe(true);
      expect(out[0]!.source).toBe("kalshi");
      expect(out[0]!.yes_bid).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips the probe when Create RFQ is forbidden", async () => {
    const pem = await generateTestPem();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes("/communications/rfqs") && method === "GET") {
        return new Response("read-only", { status: 403 });
      }
      return new Response("should not hit " + method + " " + url, { status: 500 });
    });
    try {
      const out = await probeKalshiRfqQuotes(
        {
          KALSHI_ACCESS_KEY_ID: "key",
          KALSHI_PRIVATE_KEY_PEM: pem,
          KALSHI_RFQ_PROBE_ENABLED: "1",
          KALSHI_MIN_REQUEST_GAP_MS: 0,
          HTTP_RETRIES: 0,
        },
        [combo()],
        new Map([["KXMVECROSSCATEGORY-HENRYJACK", SAME_GAME_LEGS]]),
        [
          leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.39, 0.41),
          leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0.48, 0.50),
        ],
      );
      expect(out[0]!.yes_bid).toBe(0);
      expect(out[0]!.source).toBe("kalshi");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("KXMVE ingest RFQ overlay", () => {
  it("publishes solicited RFQ bid/ask on a same-game combo", async () => {
    const pem = await generateTestPem();
    const posts: unknown[] = [];
    const methods: string[] = [];
    const sameGameCombo = {
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
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      methods.push(`${method} ${url}`);
      if (url.includes("mve_filter=only")) {
        return new Response(JSON.stringify({ markets: [sameGameCombo], cursor: "" }), { status: 200 });
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
        return new Response(JSON.stringify({ id: "rfq-ingest" }), { status: 201 });
      }
      if (url.includes("/communications/quotes")) {
        return new Response(JSON.stringify({
          quotes: [{ status: "open", yes_bid_dollars: "0.22", no_bid_dollars: "0.70" }],
        }), { status: 200 });
      }
      if (url.includes("/communications/rfqs/rfq-ingest") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (url.includes("pipeline.test") && method === "POST") {
        posts.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("unexpected " + method + " " + url, { status: 500 });
    });
    try {
      const result = await publishKalshiSeries("KXMVE", {
        PIPELINE_KALSHI_MARKETS_URL: "https://pipeline.test/kalshi",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        KALSHI_MIN_REQUEST_GAP_MS: 0,
        KALSHI_SPORTS_LOOKBACK_DAYS: 0,
        KALSHI_RFQ_PROBE_ENABLED: "1",
        KALSHI_RFQ_WAIT_MS: 0,
        KALSHI_RFQ_POLL_MS: 0,
        KALSHI_ACCESS_KEY_ID: "key",
        KALSHI_PRIVATE_KEY_PEM: pem,
        runId: () => "run-rfq",
      });
      expect(result.published).toBe(true);
      const body = posts[0] as Array<Record<string, unknown>>;
      const comboRow = body.find((r) => r.market_ticker === "KXMVECROSSCATEGORY-HENRYJACK");
      expect(comboRow?.source).toBe("kalshi_rfq");
      expect(comboRow?.yes_bid).toBeCloseTo(0.22);
      expect(comboRow?.yes_ask).toBeCloseTo(0.30);
      expect(methods.some((m) => /ACCEPT|CONFIRM/i.test(m))).toBe(false);
      expect(methods.some((m) => m.startsWith("DELETE ") && m.includes("/rfqs/rfq-ingest"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
