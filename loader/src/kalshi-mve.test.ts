import { describe, expect, it } from "vitest";
import {
  encodeMveCategory,
  eventPrefixFromTicker,
  isSportsParlayCandidate,
  parseMveCategory,
  parseMveSelectedLegs,
  parlayGameGroup,
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

  it("requires structured legs", () => {
    expect(isSportsParlayCandidate({
      ticker: "KXNFL-EMPTY",
      series_ticker: "KXNFLGAME",
      title: "Chiefs win",
      category: "Sports",
    }, new Set())).toBe(false);
  });
});

describe("game grouping", () => {
  it("treats one event as same-game and two events as cross-game", () => {
    expect(parlayGameGroup(["KXNFLGAME-26SEP13KC", "KXNFLGAME-26SEP13KC"])).toBe("same_game");
    expect(parlayGameGroup(["KXNFLGAME-26SEP13KC", "KXNFLGAME-26SEP13BUF"])).toBe("cross_game");
    expect(eventPrefixFromTicker("KXNFLGAME-26SEP13KC-KC")).toBe("KXNFLGAME-26SEP13KC");
    expect(seriesTickerFromMarketTicker("KXNFLGAME-26SEP13KC-KC")).toBe("KXNFLGAME");
  });
});
