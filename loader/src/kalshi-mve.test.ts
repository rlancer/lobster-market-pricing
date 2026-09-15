import { describe, expect, it } from "vitest";
import {
  encodeMveCategory,
  eventPrefixFromTicker,
  isCrossGameSportsTwoLeg,
  isSameGameSportsTwoLeg,
  isSportsParlayCandidate,
  parseMveCategory,
  parseMveSelectedLegs,
  parlayGameGroup,
  sportsGameKey,
  seriesTickerFromMarketTicker,
} from "./kalshi-mve.js";

const COMBO = {
  ticker: "KXNFLPARLAY-26SEP13-KCBUF",
  series_ticker: "KXNFLPARLAY",
  title: "Chiefs win AND Bills win",
  category: "Sports",
  mve_collection_ticker: "KXMVESPORT-NFL",
  mve_selected_legs: [
    { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-KC", side: "yes" },
    { event_ticker: "KXNFLGAME-26SEP13BUF", market_ticker: "KXNFLGAME-26SEP13BUF-BUF", side: "yes" },
  ],
};

describe("mve selected legs + category encoding", () => {
  it("parses Kalshi mve_selected_legs", () => {
    const legs = parseMveSelectedLegs(COMBO);
    expect(legs).toHaveLength(2);
    expect(legs[0].market_ticker).toBe("KXNFLGAME-26SEP13KC-KC");
    expect(legs[0].side).toBe("yes");
    expect(legs[1].event_ticker).toBe("KXNFLGAME-26SEP13BUF");
  });

  it("round-trips collection + legs through category", () => {
    const legs = parseMveSelectedLegs(COMBO);
    const category = encodeMveCategory("KXMVESPORT-NFL", legs);
    expect(category.startsWith("mve|")).toBe(true);
    const parsed = parseMveCategory(category);
    expect(parsed?.collection).toBe("KXMVESPORT-NFL");
    expect(parsed?.legs.map((l) => l.market_ticker)).toEqual([
      "KXNFLGAME-26SEP13KC-KC",
      "KXNFLGAME-26SEP13BUF-BUF",
    ]);
    expect(parsed?.legs.map((l) => l.event_ticker)).toEqual([
      "KXNFLGAME-26SEP13KC",
      "KXNFLGAME-26SEP13BUF",
    ]);
  });

  it("still parses older category rows that omit @event", () => {
    const parsed = parseMveCategory("mve|KXMVESPORT-NFL|yes:KXNFLGAME-1-KC,no:KXNFLGAME-1-BUF");
    expect(parsed?.legs[0]?.event_ticker).toBeNull();
    expect(parsed?.legs[1]?.side).toBe("no");
  });

  it("rejects a one-leg category", () => {
    expect(parseMveCategory("mve|COLL|yes:ONLYONE")).toBeNull();
    expect(parseMveCategory("Sports")).toBeNull();
  });
});

describe("sports parlay filter", () => {
  it("keeps NFL parlays and drops investing series even if they have legs", () => {
    const investing = new Set(["KXFEDCOMBO", "KXFED"]);
    expect(isSportsParlayCandidate(COMBO, investing)).toBe(true);
    expect(isSportsParlayCandidate({
      ...COMBO,
      series_ticker: "KXFEDCOMBO",
      ticker: "KXFEDCOMBO-26SEPB-25H-T0",
      title: "Fed hike and dissent",
      category: "Economics",
    }, investing)).toBe(false);
  });

  it("rejects pure crypto 15m and daily CROSSCATEGORY stacks as sports parlays", () => {
    const investing = new Set(["KXBTC", "KXETH"]);
    expect(isSportsParlayCandidate({
      ticker: "KXMVECROSSCATEGORY-CRYPTO",
      series_ticker: "KXMVE",
      title: "yes Target Price: $77,307.93,yes Target Price: $2505",
      mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
      mve_selected_legs: [
        { market_ticker: "KXBTC15M-26SEP131430-30", side: "yes" },
        { market_ticker: "KXETH15M-26SEP131430-30", side: "yes" },
      ],
    }, investing)).toBe(false);
    expect(isSportsParlayCandidate({
      ticker: "KXMVECROSSCATEGORY-NFL",
      series_ticker: "KXMVE",
      title: "yes Derrick Henry: 110+,yes Lamar Jackson: 40+",
      mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
      mve_selected_legs: [
        { market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", side: "yes" },
        { market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", side: "yes" },
      ],
    }, investing)).toBe(true);
    expect(isSportsParlayCandidate({
      ticker: "KXMVECROSSCATEGORY-DAILYCRYPTO",
      series_ticker: "KXMVE",
      title: "yes $77,300 or above,yes $100.75 or above",
      mve_collection_ticker: "KXMVECROSSCATEGORY-SHARD1-R",
      mve_selected_legs: [
        { market_ticker: "KXBTCD-26SEP1315-T77299.99", side: "yes" },
        { market_ticker: "KXSOLD-26SEP1315-T100.7499", side: "yes" },
      ],
    }, investing)).toBe(false);
  });
});

describe("game grouping", () => {
  it("treats one event as same-game and two events as cross-game", () => {
    expect(parlayGameGroup(["KXNFLGAME-26SEP13KC", "KXNFLGAME-26SEP13KC"])).toBe("same_game");
    expect(parlayGameGroup(["KXNFLGAME-26SEP13KC", "KXNFLGAME-26SEP13BUF"])).toBe("cross_game");
    expect(eventPrefixFromTicker("KXNFLGAME-26SEP13KC-KC")).toBe("KXNFLGAME-26SEP13KC");
    expect(seriesTickerFromMarketTicker("KXNFLGAME-26SEP13KC-KC")).toBe("KXNFLGAME");
    expect(sportsGameKey("KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110")).toBe("26SEP13BALIND");
    expect(sportsGameKey("KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40")).toBe("26SEP13BALIND");
  });

  it("keeps same-game two-leg sports stacks and drops n>2 or cross-game", () => {
    expect(isSameGameSportsTwoLeg([
      { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", side: "yes" },
      { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", side: "yes" },
    ])).toBe(true);
    expect(isSameGameSportsTwoLeg([
      { event_ticker: "KXWNBAGAME-2026-09-14-NYL-LAS", market_ticker: "KXWNBAGAME-NYL-WIN", side: "yes" },
      { event_ticker: "KXWNBAGAME-2026-09-14-NYL-LAS", market_ticker: "KXWNBAGAME-LAS-WIN", side: "yes" },
    ])).toBe(true);
    expect(isSameGameSportsTwoLeg([
      { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-KC", side: "yes" },
      { event_ticker: "KXNFLGAME-26SEP13BUF", market_ticker: "KXNFLGAME-26SEP13BUF-BUF", side: "yes" },
    ])).toBe(false);
    expect(isSameGameSportsTwoLeg([
      { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", side: "yes" },
      { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", side: "yes" },
      { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALFLOW-50", side: "yes" },
    ])).toBe(false);
    expect(isCrossGameSportsTwoLeg([
      { event_ticker: "KXNFLGAME-26SEP13KC", market_ticker: "KXNFLGAME-26SEP13KC-KC", side: "yes" },
      { event_ticker: "KXNFLGAME-26SEP13BUF", market_ticker: "KXNFLGAME-26SEP13BUF-BUF", side: "yes" },
    ])).toBe(true);
    expect(isCrossGameSportsTwoLeg([
      { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTENRY22-110", side: "yes" },
      { event_ticker: "KXNFLRSHYDS-26SEP13BALIND", market_ticker: "KXNFLRSHYDS-26SEP13BALIND-BALTJACK8-40", side: "yes" },
    ])).toBe(false);
  });
});
