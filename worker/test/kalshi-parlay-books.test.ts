import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeMveCategory } from "../src/kalshi-parlay";
import {
  decideParlayBook,
  PAYOFF_YES_MAX_ASK,
  runKalshiParlayBooksExperiment,
  scoreParlayBooks,
  sidePnl,
  type ParlayBookId,
} from "../src/kalshi-parlay-books";
import type { ParlayBacktestMarket } from "../src/kalshi-parlay-backtest";

function lakeRow(
  partial: Partial<ParlayBacktestMarket> & Pick<ParlayBacktestMarket, "market_ticker">,
): ParlayBacktestMarket {
  return {
    event_ticker: null,
    title: partial.title ?? partial.market_ticker,
    category: null,
    status: "active",
    yes_bid: 0.4,
    yes_ask: 0.42,
    yes_last: 0.41,
    volume: 10,
    close_time: null,
    fetched_at: "2026-09-14T23:00:00.000Z",
    source: "kalshi",
    ...partial,
  };
}

/** Last night's 17 BUY NO fills (prices + YES settlement). */
const LIVE_FILLS: Array<{ ticker: string; title: string; yes: number; no: number; settlement: 0 | 1; at: string }> = [
  { ticker: "KXMVE-T1", title: "yes Adam Trautman: 2+,yes Courtland Sutton: 3+", yes: 0.25, no: 0.75, settlement: 0, at: "2026-09-15T00:52:39Z" },
  { ticker: "KXMVE-T2", title: "yes Corbin Carroll: 3+,yes Javier Sanoja: 2+", yes: 0.10, no: 0.90, settlement: 1, at: "2026-09-15T00:47:25Z" },
  { ticker: "KXMVE-T3", title: "yes Kyle Stowers: 2+,yes Xavier Edwards: 2+", yes: 0.143, no: 0.857, settlement: 1, at: "2026-09-15T00:25:43Z" },
  { ticker: "KXMVE-T4", title: "yes Dominic Canzone: 2+,yes Randy Arozarena: 2+", yes: 0.051, no: 0.949, settlement: 0, at: "2026-09-15T00:20:19Z" },
  { ticker: "KXMVE-T5", title: "yes Alec Burleson: 2+,yes Nolan Gorman: 2+", yes: 0.12, no: 0.88, settlement: 0, at: "2026-09-14T23:47:09Z" },
  { ticker: "KXMVE-T6", title: "yes Joshua Baez: 2+,yes Thomas Saggese: 2+", yes: 0.109, no: 0.891, settlement: 0, at: "2026-09-14T23:41:50Z" },
  { ticker: "KXMVE-T7", title: "yes Kody Clemens: 1+,yes Ben Rice: 1+", yes: 0.39, no: 0.61, settlement: 0, at: "2026-09-14T23:30:48Z" },
  { ticker: "KXMVE-T8", title: "yes Austin Wells: 1+,yes Ryan McMahon: 1+", yes: 0.256, no: 0.744, settlement: 1, at: "2026-09-14T22:12:23Z" },
  { ticker: "KXMVE-T9", title: "yes Jaylen Waddle: 70+,yes Pat Bryant: 25+", yes: 0.171, no: 0.829, settlement: 0, at: "2026-09-14T22:00:20Z" },
  { ticker: "KXMVE-T10", title: "yes Jordan Walker: 1+,yes Thomas Saggese: 1+", yes: 0.394, no: 0.606, settlement: 1, at: "2026-09-14T21:50:01Z" },
  { ticker: "KXMVE-T11", title: "no Jaylen Waddle: 6+,no Travis Kelce: 5+", yes: 0.348, no: 0.652, settlement: 1, at: "2026-09-14T21:39:08Z" },
  { ticker: "KXMVE-T12", title: "yes Michael Harris: 3+,yes Alex Bregman: 3+", yes: 0.104, no: 0.896, settlement: 0, at: "2026-09-14T21:27:39Z" },
  { ticker: "KXMVE-T13", title: "yes Eugenio Suárez: 1+,yes Max Muncy (LAD): 1+", yes: 0.238, no: 0.762, settlement: 0, at: "2026-09-14T20:37:32Z" },
  { ticker: "KXMVE-T14", title: "yes Elly De La Cruz: 2+,yes Tommy Edman: 2+", yes: 0.125, no: 0.875, settlement: 0, at: "2026-09-14T20:16:25Z" },
  { ticker: "KXMVE-T15", title: "yes Matt Olson: 1+,yes Michael Busch: 1+", yes: 0.113, no: 0.887, settlement: 0, at: "2026-09-14T20:05:56Z" },
  { ticker: "KXMVE-T16", title: "no J.K. Dobbins: 60+,no Patrick Mahomes: 25+", yes: 0.425, no: 0.575, settlement: 1, at: "2026-09-14T19:47:35Z" },
  { ticker: "KXMVE-T17", title: "yes Bo Bichette: 2+,yes Francisco Lindor: 2+", yes: 0.154, no: 0.846, settlement: 0, at: "2026-09-14T19:36:59Z" },
];

function liveFillMarkets(): ParlayBacktestMarket[] {
  const rows: ParlayBacktestMarket[] = [];
  for (const fill of LIVE_FILLS) {
    rows.push(lakeRow({
      market_ticker: fill.ticker,
      title: fill.title,
      category: "mve|KXMVESPORT-MLB|yes:KXMLBHITS-A@KXMLBGAME-26SEP14AAA,yes:KXMLBHITS-B@KXMLBGAME-26SEP14BBB",
      yes_bid: fill.yes,
      yes_ask: fill.yes,
      yes_last: fill.yes,
      no_bid: fill.no,
      volume: 10,
      source: "kalshi_parlay_fill",
      fetched_at: fill.at,
    }));
    rows.push(lakeRow({
      market_ticker: fill.ticker,
      title: fill.title,
      status: "settled",
      yes_bid: fill.settlement,
      yes_ask: fill.settlement,
      yes_last: fill.settlement,
      source: "kalshi_settlement",
      fetched_at: "2026-09-15T06:00:00.000Z",
    }));
  }
  return rows;
}

function book(snapshot: ReturnType<typeof scoreParlayBooks>, id: ParlayBookId) {
  const row = snapshot.books.find((item) => item.id === id);
  assert.ok(row, `missing book ${id}`);
  return row;
}

describe("parlay book bakeoff", () => {
  it("grades last night's 17 fills: underdog/always-YES beat corr-room and always-NO", () => {
    const snapshot = scoreParlayBooks(liveFillMarkets(), { now: Date.parse("2026-09-15T15:00:00Z") });
    assert.equal(snapshot.universes.fills.settled, 17);
    assert.equal(snapshot.design_id, "kalshi-parlay-books-v1");

    const alwaysYes = book(snapshot, "always_yes").fills;
    const alwaysNo = book(snapshot, "always_no").fills;
    const underdog = book(snapshot, "underdog").fills;
    const payoff = book(snapshot, "payoff_yes").fills;
    const corr = book(snapshot, "corr_room_yes").fills;

    assert.equal(alwaysYes.taken, 17);
    assert.ok(alwaysYes.pnl > 23 && alwaysYes.pnl < 24, `always YES ${alwaysYes.pnl}`);
    assert.ok(alwaysNo.pnl < -26 && alwaysNo.pnl > -28, `always NO ${alwaysNo.pnl}`);
    assert.equal(underdog.taken, 17);
    assert.ok(Math.abs(underdog.pnl - alwaysYes.pnl) < 1e-9, "every combo YES was the cheap side");
    assert.equal(payoff.taken, LIVE_FILLS.filter((f) => f.yes <= PAYOFF_YES_MAX_ASK).length);
    assert.ok(payoff.pnl > 9 && payoff.pnl < 10, `payoff YES ${payoff.pnl}`);
    assert.ok(payoff.pnl < alwaysYes.pnl, "30¢ cap skipped richer YES hits");
    assert.equal(corr.taken, 0);
    assert.equal(corr.pnl, 0);
    assert.match(snapshot.headline, /Underdog side/i);
    assert.match(snapshot.headline, /Corr-room YES took 0/);
  });

  it("price buckets show YES +EV below 50¢ on last night's tape in aggregate", () => {
    const snapshot = scoreParlayBooks(liveFillMarkets());
    const below50 = snapshot.buckets.filter((b) => b.hi <= 0.50 && b.n > 0);
    assert.ok(below50.length >= 4);
    const yes = below50.reduce((s, b) => s + b.yes_pnl, 0);
    const no = below50.reduce((s, b) => s + b.no_pnl, 0);
    assert.ok(yes > 20 && no < -20, `YES ${yes} vs NO ${no}`);
    const dust = snapshot.buckets.find((b) => b.lo === 0);
    assert.ok(dust && dust.n === 1 && dust.hits === 0, "5¢ ticket missed — cheap is not free edge");
    const mid = snapshot.buckets.find((b) => b.lo === 0.30);
    assert.ok(mid && mid.n === 3 && mid.hits === 2);
    assert.ok(mid.yes_pnl > 8);
  });

  it("same-game RFQ near independence is the only corr-room take", () => {
    const category = encodeMveCategory("KXMVESPORT-MLB", [
      { event_ticker: "KXMLBGAME-26SEP14ATLHOU", market_ticker: "KXMLBHITS-HARRIS-3", side: "yes" },
      { event_ticker: "KXMLBGAME-26SEP14ATLHOU", market_ticker: "KXMLBHITS-BREGMAN-3", side: "yes" },
    ]);
    const snapshot = scoreParlayBooks([
      lakeRow({
        market_ticker: "KXMVE-HARRIS-BREGMAN",
        title: "Harris 3+ AND Bregman 3+",
        category,
        yes_bid: 0.18,
        yes_ask: 0.20,
        source: "kalshi_rfq",
        fetched_at: "2026-09-14T23:10:00.000Z",
      }),
      lakeRow({
        market_ticker: "KXMVE-HARRIS-BREGMAN",
        title: "Harris 3+ AND Bregman 3+",
        category,
        status: "settled",
        yes_bid: 1,
        yes_ask: 1,
        yes_last: 1,
        source: "kalshi_settlement",
        fetched_at: "2026-09-15T04:00:00.000Z",
      }),
      lakeRow({
        market_ticker: "KXMLBHITS-HARRIS-3",
        event_ticker: "KXMLBGAME-26SEP14ATLHOU",
        yes_bid: 0.39,
        yes_ask: 0.41,
        yes_last: 0.40,
      }),
      lakeRow({
        market_ticker: "KXMLBHITS-BREGMAN-3",
        event_ticker: "KXMLBGAME-26SEP14ATLHOU",
        yes_bid: 0.48,
        yes_ask: 0.50,
        yes_last: 0.49,
      }),
    ]);
    const corr = book(snapshot, "corr_room_yes").rfq;
    const underdog = book(snapshot, "underdog").rfq;
    const sameGame = book(snapshot, "same_game_underdog").rfq;
    assert.equal(corr.taken, 1);
    assert.equal(corr.settled, 1);
    assert.ok(corr.pnl > 7);
    assert.equal(underdog.taken, 1);
    assert.equal(sameGame.taken, 1);
    assert.equal(book(snapshot, "always_no").rfq.pnl < 0, true);
  });

  it("underdog buys NO only when YES is the expensive side", () => {
    const ticket = {
      market_ticker: "X",
      title: "rich yes",
      quoted_at: null,
      universe: "fill" as const,
      yes_price: 0.72,
      no_price: 0.28,
      contracts: 10,
      p: null,
      q: null,
      same_game: true,
      same_side: true,
      corr_room: null,
      independence: null,
      phi: null,
      corr_room_ok: false,
      settlement: 0 as const,
    };
    assert.equal(decideParlayBook("underdog", ticket), "no");
    assert.equal(decideParlayBook("payoff_yes", ticket), "skip");
    assert.equal(decideParlayBook("always_yes", ticket), "yes");
    const pnl = sidePnl("no", 0, 0.72, 0.28, 10);
    assert.ok(pnl > 6);
  });

  it("empty lake is a quiet snapshot, not a throw", () => {
    const snapshot = scoreParlayBooks([]);
    assert.equal(snapshot.universes.combined.n, 0);
    assert.equal(snapshot.books.length, 6);
    assert.match(snapshot.headline, /No settled live fills/);
  });

  it("shortens Kalshi 429 hydrate errors for the notebook", async () => {
    const snapshot = await runKalshiParlayBooksExperiment({
      queryKalshiSports: async () => [{
        series_ticker: "KXMVE",
        market_ticker: "KXMVE-T1",
        event_ticker: null,
        title: "fill",
        yes_subtitle: "buy_no",
        theme: "sports",
        category: "mve|KXMVESPORT-MLB|yes:KXMLBHITS-A@KXMLBGAME-X,yes:KXMLBHITS-B@KXMLBGAME-Y",
        status: "active",
        market_type: "multivariate",
        yes_bid: 0.2,
        yes_ask: 0.2,
        yes_last: 0.2,
        volume: 10,
        close_time: null,
        fetched_at: "2026-09-15T00:00:00.000Z",
        source: "kalshi_parlay_fill",
        no_bid: 0.8,
      }],
      fetchJson: async () => {
        throw new Error('Kalshi HTTP 429: {"error":{"code":"too_many_requests","message":"too many requests"}}');
      },
    });
    assert.equal(snapshot.errors.length, 1);
    assert.match(snapshot.errors[0]!, /HTTP 429/);
    assert.doesNotMatch(snapshot.errors[0]!, /too_many_requests/);
  });
});
