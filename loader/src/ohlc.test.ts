import { describe, expect, it } from "vitest";
import {
  DailyBar,
  OHLC_FIELDS,
  REALIZED_VOL_FIELDS,
  normalizeOhlcRecords,
  normalizeRealizedVolRecord,
  parseYahooChart,
  realizedVols,
} from "./ohlc";

const FIXED_RUN_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const FIXED_NOW = "2026-08-07T15:00:00.000Z";

// Closes that step up 1% each trading day → realized vol of the 1% step.
function closesOfStep(step: number, n: number): number[] {
  const out: number[] = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    out.push(c);
    c *= 1 + step;
  }
  return out;
}

function barsFromCloses(closes: number[]): DailyBar[] {
  return closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: close,
    high: close,
    low: close,
    close,
    adjustedClose: close,
    volume: 1000,
  }));
}

// Build a Yahoo-chart payload from a list of [tsSec, ohlcv] rows.
function chartPayload(
  symbol: string,
  rows: Array<[number, number, number, number, number, number]>,
  gmtoffset = 0,
): unknown {
  return {
    chart: {
      result: [
        {
          meta: { symbol, gmtoffset },
          timestamp: rows.map((r) => r[0]),
          indicators: {
            quote: [
              {
                open: rows.map((r) => r[1]),
                high: rows.map((r) => r[2]),
                low: rows.map((r) => r[3]),
                close: rows.map((r) => r[4]),
                volume: rows.map((r) => r[5]),
              },
            ],
          },
        },
      ],
    },
  };
}

describe("parseYahooChart", () => {
  it("parses rows into ascending daily bars with exchange-local dates", () => {
    // 2026-01-02 .. 2026-01-05 in ET (gmtoffset -5h = -18000s)
    const payload = chartPayload(
      "AAPL",
      [
        [1767312000, 100, 101, 99, 100.5, 1000],
        [1767398400, 101, 102, 100, 101.5, 2000],
      ],
      -18000,
    );
    const bars = parseYahooChart(payload, "AAPL");
    expect(bars).toHaveLength(2);
    expect(bars[0].date).toBe(bars[1].date < bars[0].date ? "" : bars[0].date);
    expect(bars[1].date).toBeTruthy();
    expect(bars[1].close).toBe(101.5);
  });

  it("throws when there is no result or no bars", () => {
    expect(() => parseYahooChart({ chart: { result: [] } }, "AAPL")).toThrow();
    const empty = chartPayload("AAPL", []);
    expect(() => parseYahooChart(empty, "AAPL")).toThrow();
  });
});

describe("realizedVols", () => {
  it("annualizes a constant 1%/day drift to a known sample-stdev value", () => {
    // 91 closes → 90 log returns all equal ln(1.01). Sample stdev of a
    // constant series is 0 → realized vol 0 for a pure drift. Use alternating
    // +/-1% instead for a non-degenerate stdev.
    const closes: number[] = [];
    let c = 100;
    for (let i = 0; i < 91; i++) {
      closes.push(c);
      c *= i % 2 === 0 ? 1.01 : 0.99;
    }
    const bars = barsFromCloses(closes);
    const rv = realizedVols(bars);
    expect(rv.realized_vol_90d).not.toBeNull();
    expect(rv.realized_vol_30d).not.toBeNull();
    expect(rv.n_returns_90).toBe(90);
    expect(rv.n_returns_30).toBe(30);
    // Exact cross-check (independent Python reference): annualized sample stdev
    // of the trailing 30 log-returns = 0.16146424861723482.
    expect(rv.realized_vol_30d).toBeCloseTo(0.16146424861723482, 12);
    expect(rv.realized_vol_90d).toBeCloseTo(0.1596397352606114, 12);
  });

  it("returns null when too few bars for a window", () => {
    const bars = barsFromCloses(closesOfStep(0.01, 10));
    const rv = realizedVols(bars);
    expect(rv.realized_vol_30d).toBeNull();
    expect(rv.realized_vol_90d).toBeNull();
    expect(rv.n_returns_30).toBe(0);
  });

  it("reports the latest bar date as as_of_date", () => {
    const bars = barsFromCloses(closesOfStep(0.01, 40));
    const last = [...bars].reverse()[0].date;
    expect(realizedVols(bars).as_of_date).toBe(last);
  });
});

describe("normalize", () => {
  it("emits ohlc records in exact OHLC_FIELDS order", () => {
    const bars = barsFromCloses([100, 101]);
    const recs = normalizeOhlcRecords(
      "AAPL", bars, "yahoo", FIXED_RUN_ID, "2026-08-07", FIXED_NOW,
    );
    expect(recs).toHaveLength(2);
    expect(Object.keys(recs[0])).toEqual([...OHLC_FIELDS]);
    expect(recs[0].symbol).toBe("AAPL");
    expect(recs[0].source).toBe("yahoo");
    expect(recs[0].run_id).toBe(FIXED_RUN_ID);
    expect(recs[0].fetched_at).toBe(FIXED_NOW);
  });

  it("drops bars with null/non-finite close so they cannot shadow good lake rows", () => {
    const bars: DailyBar[] = [
      {
        date: "2026-08-17",
        open: 100,
        high: 101,
        low: 99,
        close: null,
        adjustedClose: null,
        volume: 1,
      },
      {
        date: "2026-08-18",
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        adjustedClose: 101,
        volume: 2,
      },
      {
        date: "2026-08-19",
        open: 101,
        high: 103,
        low: 100,
        close: Number.NaN,
        adjustedClose: null,
        volume: 3,
      },
    ];
    const recs = normalizeOhlcRecords(
      "AAPL", bars, "yahoo", FIXED_RUN_ID, "2026-08-19", FIXED_NOW,
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].date).toBe("2026-08-18");
    expect(recs[0].close).toBe(101);
  });

  it("emits a realized-vol record in exact REALIZED_VOL_FIELDS order", () => {
    const bars = barsFromCloses(closesOfStep(0.01, 40));
    const rec = normalizeRealizedVolRecord(
      "AAPL", realizedVols(bars), FIXED_RUN_ID, FIXED_NOW,
    );
    expect(Object.keys(rec)).toEqual([...REALIZED_VOL_FIELDS]);
    expect(rec.symbol).toBe("AAPL");
    expect(rec.as_of_date).toBe(realizedVols(bars).as_of_date);
  });
});
