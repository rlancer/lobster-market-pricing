// Live probe for curated Kalshi series → open market snapshots (dry-run).
//   node --experimental-strip-types tools/kalshi_probe.ts
import { fetchKalshiSeriesMarkets, kalshiSeriesList, KALSHI_SERIES } from "../src/kalshi.ts";

const results: Array<Record<string, unknown>> = [];
for (const seriesId of kalshiSeriesList()) {
  const meta = KALSHI_SERIES[seriesId];
  try {
    const rows = await fetchKalshiSeriesMarkets(seriesId, { HTTP_RETRIES: 2 });
    const sample = rows[0];
    results.push({
      series_ticker: seriesId,
      theme: meta?.theme,
      related_symbol: meta?.related_symbol,
      open_markets: rows.length,
      sample: sample
        ? {
            market_ticker: sample.market_ticker,
            title: sample.title.slice(0, 80),
            yes_bid: sample.yes_bid,
            yes_ask: sample.yes_ask,
            yes_last: sample.yes_last,
            volume: sample.volume,
            close_time: sample.close_time,
          }
        : null,
    });
  } catch (error) {
    results.push({
      series_ticker: seriesId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify(results, null, 2));
