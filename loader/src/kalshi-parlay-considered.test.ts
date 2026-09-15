import { describe, expect, it } from "vitest";
import type { KalshiMarketRow } from "./kalshi.js";
import type { MveSelectedLeg } from "./kalshi-mve.js";
import {
  annotateParlayConsidered,
  explainParlaySkip,
  listSameGameConsidered,
} from "./kalshi-parlay-considered.js";

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
    category: "mve|COLL|yes:A,yes:B",
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

function leg(ticker: string, bid: number, ask: number, title = ticker): KalshiMarketRow {
  return {
    series_ticker: "KXNFLRSHYDS",
    market_ticker: ticker,
    event_ticker: "KXNFLRSHYDS-26SEP13BALIND",
    title,
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

describe("listSameGameConsidered", () => {
  it("shows legs and skips when corr room is below 15¢ on the corr-room book", () => {
    const rows = listSameGameConsidered(
      [combo({ market_ticker: "LOW-ROOM" })],
      new Map([["LOW-ROOM", SAME_GAME_LEGS]]),
      [
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.88, 0.92, "Henry 110+"),
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0.88, 0.92, "Jackson 40+"),
      ],
      { book: "corr_room_yes" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.legs.map((l) => l.title)).toEqual(["Henry 110+", "Jackson 40+"]);
    expect(rows[0]!.skip).toBe("corr_room");
    expect(rows[0]!.status).toBe("skipped");
    expect(rows[0]!.reason).toMatch(/not correlated enough/);
    expect(rows[0]!.reason).toMatch(/need 15¢/);
    expect(rows[0]!.corr_room).toBeLessThan(0.15);
  });

  it("keeps a low-corr same-game stack eligible on the underdog book", () => {
    const rows = listSameGameConsidered(
      [combo({ market_ticker: "LOW-ROOM" })],
      new Map([["LOW-ROOM", SAME_GAME_LEGS]]),
      [
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.88, 0.92, "Henry 110+"),
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0.88, 0.92, "Jackson 40+"),
      ],
      { book: "same_game_underdog" },
    );
    expect(rows[0]!.skip).toBeNull();
    expect(rows[0]!.reason).toMatch(/cheapest independence/);
  });

  it("flags missing tradable leg mids", () => {
    const rows = listSameGameConsidered(
      [combo()],
      new Map([["KXMVECROSSCATEGORY-HENRYJACK", SAME_GAME_LEGS]]),
      [
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0, 0),
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0, 0),
      ],
    );
    expect(rows[0]!.skip).toBe("missing_leg_mids");
    expect(rows[0]!.reason).toMatch(/No tradable prices/);
  });
});

describe("annotateParlayConsidered", () => {
  it("marks a dry-run would_accept and a max-accepts skip", () => {
    const listed = listSameGameConsidered(
      [
        combo({ market_ticker: "A" }),
        combo({ market_ticker: "B" }),
      ],
      new Map([
        ["A", SAME_GAME_LEGS],
        ["B", SAME_GAME_LEGS],
      ]),
      [
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.39, 0.41, "Henry 110+"),
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0.48, 0.50, "Jackson 40+"),
      ],
    );
    const annotated = annotateParlayConsidered(listed, {
      targetTickers: new Set(["A", "B"]),
      decisions: [{
        market_ticker: "A",
        would_accept: true,
        accepted: true,
        error: null,
        reasons: [],
        yes_ask: 0.18,
      }],
      live: true,
      acceptedCount: 1,
      maxAccepts: 1,
    });
    expect(annotated[0]!.status).toBe("accepted");
    expect(annotated[0]!.reason).toMatch(/Accepted YES at ask 0.180/);
    expect(annotated[1]!.skip).toBe("max_accepts");
    expect(annotated[1]!.reason).toMatch(/already filled this pass/);
  });

  it("keeps corr-room skip ahead of max-accepts", () => {
    const listed = listSameGameConsidered(
      [combo({ market_ticker: "LOW" })],
      new Map([["LOW", SAME_GAME_LEGS]]),
      [
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", 0.88, 0.92, "Henry 110+"),
        leg("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", 0.88, 0.92, "Jackson 40+"),
      ],
      { book: "corr_room_yes" },
    );
    const annotated = annotateParlayConsidered(listed, {
      targetTickers: new Set(["LOW"]),
      decisions: [],
      live: true,
      acceptedCount: 1,
      maxAccepts: 1,
    });
    expect(annotated[0]!.skip).toBe("corr_room");
    expect(annotated[0]!.reason).toMatch(/not correlated enough/);
  });
});

describe("explainParlaySkip", () => {
  it("names corr room in cents", () => {
    expect(explainParlaySkip(["corr_room"], { corr_room: 0.08 })).toBe(
      "Legs are not correlated enough (corr room 8¢, need 15¢)",
    );
  });
});
