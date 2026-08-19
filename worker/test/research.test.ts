import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzePriceAction, getOrComputeResearch, parseTickerParam, summarizeResearch, warmResearchTickers, type OhlcBar, type ResearchDeps, type TickerResearch } from "../src/research";
import { identityFromOpenFigi, identityFromTicker, resolveTickerIdentity } from "../src/figi";
import { normalizeTicker, securityIdForTicker } from "../src/symbology";

function bar(date: string, close: number, volume: number, high?: number, low?: number): OhlcBar {
  return {
    date,
    open: close,
    high: high ?? close * 1.01,
    low: low ?? close * 0.99,
    close,
    volume,
  };
}

describe("symbology", () => {
  it("normalizes and seeds stable security ids", () => {
    assert.equal(normalizeTicker(" aapl "), "AAPL");
    assert.equal(securityIdForTicker("AAPL"), securityIdForTicker("aapl"));
    assert.notEqual(securityIdForTicker("AAPL"), securityIdForTicker("MSFT"));
  });
});

describe("figi identity", () => {
  it("prefers OpenFIGI canonical ticker while keeping ticker-seeded security_id", () => {
    const id = identityFromOpenFigi("META", {
      ticker: "META",
      figi: "BBG000BPH459",
      compositeFIGI: "BBG000BPH459",
      name: "Meta Platforms Inc",
      exchCode: "US",
    }, 1_700_000_000_000);
    assert.equal(id.ticker, "META");
    assert.equal(id.security_id, securityIdForTicker("META"));
    assert.equal(id.figi, "BBG000BPH459");
    assert.equal(id.source, "openfigi");
  });

  it("falls back to ticker identity", () => {
    const id = identityFromTicker("nvda", 1);
    assert.equal(id.ticker, "NVDA");
    assert.equal(id.source, "ticker");
    assert.equal(id.figi, null);
  });
});

describe("analyzePriceAction", () => {
  it("flags consolidation and accumulation on a tight rising range", () => {
    const bars: OhlcBar[] = [];
    for (let i = 0; i < 30; i++) {
      const close = 100 + i * 0.05;
      bars.push(bar(`2026-01-${String(i + 1).padStart(2, "0")}`, close, 1_000_000 + i * 50_000, close + 0.2, close - 0.2));
    }
    const { price, technicals } = analyzePriceAction(bars);
    assert.ok(price.spot != null);
    assert.equal(technicals.consolidation, true);
    assert.ok(technicals.consolidation_range_pct != null && technicals.consolidation_range_pct <= 8);
    assert.equal(technicals.accumulation, "accumulating");
    assert.ok(technicals.notes.length >= 1);
  });

  it("detects distribution on falling closes with volume", () => {
    const bars: OhlcBar[] = [];
    for (let i = 0; i < 25; i++) {
      const close = 100 - i * 0.4;
      bars.push(bar(`2026-02-${String(i + 1).padStart(2, "0")}`, close, 2_000_000, close + 1, close - 1));
    }
    const { technicals, price } = analyzePriceAction(bars);
    assert.ok((price.change_21d_pct ?? 0) < 0);
    assert.equal(technicals.accumulation, "distributing");
    assert.equal(technicals.trend, "down");
  });
});

describe("parseTickerParam", () => {
  it("accepts exchange tickers and rejects junk", () => {
    assert.equal(parseTickerParam("aapl"), "AAPL");
    assert.equal(parseTickerParam("BRK.B"), "BRK.B");
    assert.equal(parseTickerParam(""), null);
    assert.equal(parseTickerParam("!!!"), null);
  });

  it("accepts Yahoo index and continuous futures forms", () => {
    assert.equal(parseTickerParam("^VIX"), "^VIX");
    assert.equal(parseTickerParam("^vix9d"), "^VIX9D");
    assert.equal(parseTickerParam("ES=F"), "ES=F");
    assert.equal(parseTickerParam("6e=f"), "6E=F");
    assert.equal(parseTickerParam("^"), null);
    assert.equal(parseTickerParam("=F"), null);
    assert.equal(parseTickerParam("ES=F=F"), null);
  });

  it("resolves slash futures roots to lake symbols", () => {
    assert.equal(parseTickerParam("/ES"), "ES=F");
    assert.equal(parseTickerParam("/vx"), "^VIX");
    assert.equal(parseTickerParam("/NQ"), "NQ=F");
    assert.equal(parseTickerParam("/nope"), null);
  });
});

describe("summarizeResearch", () => {
  it("renders a compact tool summary", () => {
    const research: TickerResearch = {
      identity: {
        security_id: securityIdForTicker("AAPL"),
        ticker: "AAPL",
        figi: "BBG000B9XRY4",
        composite_figi: "BBG000B9XRY4",
        isin: null,
        name: "Apple Inc",
        exchange: "US",
        currency: "USD",
        sector: "Equity",
        source: "openfigi",
        resolved_at: 1,
      },
      price: {
        spot: 190,
        change_1d_pct: 1.2,
        change_5d_pct: 3.4,
        change_21d_pct: -2.1,
        change_63d_pct: 8,
        high_63d: 200,
        low_63d: 170,
        volume_latest: 80_000_000,
        volume_avg_20d: 60_000_000,
        volume_relative_20d: 80_000_000 / 60_000_000,
      },
      technicals: {
        trend: "up",
        consolidation: false,
        consolidation_range_pct: 12,
        accumulation: "neutral",
        notes: ["No strong consolidation or volume skew in the recent window."],
      },
      realized_vol: null,
      fundamentals: {
        market_cap: 3e12,
        enterprise_value: null,
        trailing_pe: 30,
        forward_pe: 28,
        peg_ratio: null,
        price_to_book: null,
        total_debt: 1e11,
        debt_to_equity: 150,
        profit_margins: 0.25,
        revenue_growth: null,
        source: "yahoo",
      },
      earnings: [{ earnings_date: "2026-07-30", time: "after-hours", fiscal_q: "Jun/2026", eps_forecast: 1.4, last_year_eps: 1.2, name: "Apple" }],
      news: [{ title: "Apple headlines", link: "https://example.com" }],
      etf: null,
      computed_at: "2026-08-15T00:00:00.000Z",
      expires_at: "2026-08-15T01:00:00.000Z",
      cache_hit: false,
    };
    const text = summarizeResearch(research);
    assert.match(text, /AAPL/);
    assert.match(text, /figi=BBG000B9XRY4/);
    assert.match(text, /marketCap=/);
    assert.match(text, /Apple headlines/);
  });

  it("includes ETF expense ratio, net assets, and top holdings", () => {
    const research: TickerResearch = {
      identity: {
        security_id: securityIdForTicker("SPY"),
        ticker: "SPY",
        figi: null,
        composite_figi: null,
        isin: null,
        name: "SPDR S&P 500 ETF Trust",
        exchange: "US",
        currency: "USD",
        sector: null,
        source: "ticker",
        resolved_at: 1,
      },
      price: {
        spot: 500,
        change_1d_pct: 0.5,
        change_5d_pct: 1,
        change_21d_pct: 2,
        change_63d_pct: 5,
        high_63d: 510,
        low_63d: 450,
        volume_latest: 1e7,
        volume_avg_20d: 1e7,
        volume_relative_20d: 1,
      },
      technicals: {
        trend: "up",
        consolidation: false,
        consolidation_range_pct: null,
        accumulation: "neutral",
        notes: [],
      },
      realized_vol: null,
      fundamentals: {
        market_cap: null,
        enterprise_value: null,
        trailing_pe: null,
        forward_pe: null,
        peg_ratio: null,
        price_to_book: null,
        total_debt: null,
        debt_to_equity: null,
        profit_margins: null,
        revenue_growth: null,
        source: null,
      },
      earnings: [],
      news: [],
      etf: {
        name: "SPDR S&P 500 ETF Trust",
        family: "State Street",
        category: "Large Blend",
        asset_class: "Broad Market",
        net_assets: 795e9,
        expense_ratio: 0.000945,
        net_expense_ratio: 0.000945,
        trailing_yield: 0.0101,
        inception_date: "1993-01-22",
        holdings: [
          { rank: 1, holding_symbol: "NVDA", holding_name: "NVIDIA Corp", weight: 0.075 },
          { rank: 2, holding_symbol: "AAPL", holding_name: "Apple Inc", weight: 0.065 },
        ],
      },
      computed_at: "2026-08-15T00:00:00.000Z",
      expires_at: "2026-08-15T01:00:00.000Z",
      cache_hit: false,
    };
    const text = summarizeResearch(research);
    assert.match(text, /ETF:/);
    assert.match(text, /expenseRatio=0\.09%/);
    assert.match(text, /netAssets=795\.00B/);
    assert.match(text, /Top holdings/);
    assert.match(text, /NVDA/);
  });
});

function memoryDb(): D1Database {
  const identities = new Map<string, {
    security_id: string; ticker: string; figi: string | null; composite_figi: string | null;
    isin: string | null; name: string | null; exchange: string | null; currency: string | null;
    sector: string | null; source: string; resolved_at: number;
  }>();
  const research = new Map<string, { security_id: string; ticker: string; payload: string; computed_at: number; expires_at: number }>();

  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM ticker_identities")) {
            return identities.get(String(binds[0])) ?? null;
          }
          if (sql.includes("FROM ticker_research") && sql.includes("WHERE ticker")) {
            const ticker = String(binds[0]);
            const rows = [...research.values()].filter((r) => r.ticker === ticker)
              .sort((a, b) => b.computed_at - a.computed_at);
            const row = rows[0];
            return row ? { payload: row.payload, expires_at: row.expires_at } : null;
          }
          if (sql.includes("FROM ticker_research") && sql.includes("security_id")) {
            const row = research.get(String(binds[0]));
            return row ? { payload: row.payload, expires_at: row.expires_at } : null;
          }
          if (sql.includes("FROM chat_tickers")) return null;
          return null;
        },
        async run() {
          if (sql.includes("INTO ticker_identities")) {
            const ticker = String(binds[0]);
            identities.set(ticker, {
              ticker,
              security_id: String(binds[1]),
              figi: (binds[2] as string | null) ?? null,
              composite_figi: (binds[3] as string | null) ?? null,
              isin: (binds[4] as string | null) ?? null,
              name: (binds[5] as string | null) ?? null,
              exchange: (binds[6] as string | null) ?? null,
              currency: (binds[7] as string | null) ?? null,
              sector: (binds[8] as string | null) ?? null,
              source: String(binds[9]),
              resolved_at: Number(binds[10]),
            });
          }
          if (sql.includes("INTO ticker_research")) {
            const security_id = String(binds[0]);
            research.set(security_id, {
              security_id,
              ticker: String(binds[1]),
              payload: String(binds[2]),
              computed_at: Number(binds[3]),
              expires_at: Number(binds[4]),
            });
          }
          return { success: true };
        },
        async all() {
          return { results: [] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function trackingDeps(): ResearchDeps & { calls: Record<string, number> } {
  const calls = { ohlc: 0, news: 0, fundamentals: 0, earnings: 0, lake: 0, figiFetch: 0, etf: 0, rv: 0 };
  const bars: OhlcBar[] = [];
  for (let i = 0; i < 30; i++) {
    const close = 100 + i;
    bars.push({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      open: close, high: close + 1, low: close - 1, close, volume: 1_000_000,
    });
  }
  return {
    calls,
    lakeLookup: async () => {
      calls.lake++;
      return { ticker: "AAPL", name: "Apple Inc", figi: "BBG000B9XRY4", sector: "Equity" };
    },
    loadOhlc: async () => { calls.ohlc++; return bars; },
    loadRealizedVol: async () => { calls.rv++; return null; },
    loadEarnings: async () => { calls.earnings++; return []; },
    loadNews: async () => {
      calls.news++;
      return { items: [{ title: "slow tavily", link: "https://example.com" }] };
    },
    loadEtfProfile: async () => { calls.etf++; return null; },
    loadFundamentals: async () => {
      calls.fundamentals++;
      return {
        market_cap: 3e12, enterprise_value: null, trailing_pe: 30, forward_pe: 28,
        peg_ratio: null, price_to_book: null, total_debt: null, debt_to_equity: null,
        profit_margins: null, revenue_growth: null, source: "yahoo",
      };
    },
    now: () => 1_700_000_000_000,
  };
}

describe("resolveTickerIdentity", () => {
  it("does not call OpenFIGI on the default (brief) path", async () => {
    let figiCalls = 0;
    const id = await resolveTickerIdentity(
      { SCHEMA_DB: memoryDb(), OPEN_FIGI: "secret" },
      "AAPL",
      {
        fetchImpl: (async () => {
          figiCalls++;
          return new Response("[]");
        }) as typeof fetch,
        lakeLookup: async () => ({ ticker: "AAPL", name: "Apple Inc", figi: "BBG000B9XRY4" }),
      },
    );
    assert.equal(figiCalls, 0);
    assert.equal(id.source, "lake");
    assert.equal(id.name, "Apple Inc");
  });

  it("calls OpenFIGI only when liveFigi is set and lake misses", async () => {
    let figiCalls = 0;
    const id = await resolveTickerIdentity(
      { SCHEMA_DB: memoryDb(), OPEN_FIGI: "secret" },
      "AAPL",
      {
        liveFigi: true,
        lakeLookup: async () => null,
        fetchImpl: (async () => {
          figiCalls++;
          return new Response(JSON.stringify([{ data: [{ ticker: "AAPL", figi: "BBG000B9XRY4", name: "Apple Inc", exchCode: "US" }] }]));
        }) as typeof fetch,
      },
    );
    assert.equal(figiCalls, 1);
    assert.equal(id.source, "openfigi");
    assert.equal(id.figi, "BBG000B9XRY4");
  });
});

describe("getOrComputeResearch", () => {
  it("skips Tavily on the HTTP brief path and still returns lake fundamentals", async () => {
    const deps = trackingDeps();
    const research = await getOrComputeResearch(
      { SCHEMA_DB: memoryDb() },
      "AAPL",
      deps,
      { includeNews: false },
    );
    assert.equal(deps.calls.news, 0);
    assert.equal(deps.calls.ohlc, 1);
    assert.equal(deps.calls.fundamentals, 1);
    assert.equal(deps.calls.etf, 0);
    assert.equal(deps.calls.earnings, 0);
    assert.equal(research.news.length, 0);
    assert.equal(research.fundamentals.market_cap, 3e12);
    assert.equal(research.identity.source, "lake");
    assert.equal(research.cache_hit, false);
  });

  it("returns D1 cache by ticker without lake or news round-trips", async () => {
    const db = memoryDb();
    const firstDeps = trackingDeps();
    await getOrComputeResearch({ SCHEMA_DB: db }, "AAPL", firstDeps, { includeNews: false });

    const secondDeps = trackingDeps();
    const cached = await getOrComputeResearch({ SCHEMA_DB: db }, "AAPL", secondDeps, { includeNews: false });
    assert.equal(cached.cache_hit, true);
    assert.equal(secondDeps.calls.ohlc, 0);
    assert.equal(secondDeps.calls.news, 0);
    assert.equal(secondDeps.calls.fundamentals, 0);
    assert.equal(secondDeps.calls.lake, 0);
  });

  it("serves stale D1 rows immediately and schedules a refresh", async () => {
    const db = memoryDb();
    const t0 = 1_700_000_000_000;
    const firstDeps = trackingDeps();
    firstDeps.now = () => t0;
    await getOrComputeResearch({ SCHEMA_DB: db }, "AAPL", firstDeps, { includeNews: false });

    let refreshed = 0;
    let refreshPromise: Promise<unknown> | null = null;
    const staleDeps = trackingDeps();
    staleDeps.now = () => t0 + 2 * 60 * 60 * 1000; // past 1h TTL
    const served = await getOrComputeResearch({ SCHEMA_DB: db }, "AAPL", staleDeps, {
      includeNews: false,
      waitUntil: (p) => {
        refreshed++;
        refreshPromise = p;
      },
    });
    assert.equal(served.cache_hit, true);
    assert.equal(served.computed_at, new Date(t0).toISOString());
    assert.equal(refreshed, 1);
    await refreshPromise;
  });

  it("loads news when includeNews is set (Copilot tool path)", async () => {
    const deps = trackingDeps();
    const research = await getOrComputeResearch(
      { SCHEMA_DB: memoryDb() },
      "AAPL",
      deps,
      { includeNews: true },
    );
    assert.equal(deps.calls.news, 1);
    assert.equal(research.news[0]?.title, "slow tavily");
  });
});

describe("warmResearchTickers", () => {
  it("force-warms a batch into D1 and reports per-ticker results", async () => {
    const db = memoryDb();
    const deps = trackingDeps();
    const summary = await warmResearchTickers({ SCHEMA_DB: db }, ["aapl", "MSFT", "aapl"], deps, {
      concurrency: 2,
      includeSecondary: true,
    });
    assert.equal(summary.attempted, 2);
    assert.equal(summary.warmed, 2);
    assert.equal(summary.failed, 0);
    assert.equal(deps.calls.ohlc, 2);
    assert.equal(deps.calls.earnings, 2);

    const cached = await getOrComputeResearch({ SCHEMA_DB: db }, "AAPL", trackingDeps(), {
      includeNews: false,
    });
    assert.equal(cached.cache_hit, true);
  });

  it("skips invalid tickers and keeps valid ones", async () => {
    const summary = await warmResearchTickers(
      { SCHEMA_DB: memoryDb() },
      ["AAPL", "!!!", ""],
      trackingDeps(),
      { concurrency: 1 },
    );
    assert.equal(summary.attempted, 1);
    assert.equal(summary.warmed, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.results[0]?.ticker, "AAPL");
  });
});
