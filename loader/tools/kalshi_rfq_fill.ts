/**
 * Solicit capped same-game sports RFQ quotes and optionally publish to
 * options.kalshi_markets. Never accepts/confirms.
 *
 *   KALSHI_ACCESS_KEY_ID=… KALSHI_PRIVATE_KEY_PEM=… KALSHI_RFQ_PROBE_ENABLED=1 \
 *     npx vite-node tools/kalshi_rfq_fill.ts
 *
 * Set PIPELINE_KALSHI_MARKETS_URL (+ PIPELINE_AUTH_TOKEN) to publish.
 * KALSHI_SPORTS_LOOKBACK_DAYS defaults to 0 here (live books + RFQ only).
 */
import { writeFileSync } from "node:fs";
import {
  fetchKalshiSportsParlays,
  kalshiAuthConfigured,
  publishKalshiMarketRows,
  type KalshiEnv,
} from "../src/kalshi.ts";
import { KALSHI_RFQ_SOURCE } from "../src/kalshi-rfq-quotes.ts";

function envFromProcess(): KalshiEnv {
  const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || "").replace(/\\n/g, "\n").trim();
  return {
    KALSHI_ACCESS_KEY_ID: process.env.KALSHI_ACCESS_KEY_ID,
    KALSHI_PRIVATE_KEY_PEM: pem,
    KALSHI_RFQ_PROBE_ENABLED: process.env.KALSHI_RFQ_PROBE_ENABLED || "1",
    KALSHI_RFQ_PROBE_MAX: process.env.KALSHI_RFQ_PROBE_MAX || "12",
    KALSHI_SPORTS_LOOKBACK_DAYS: process.env.KALSHI_SPORTS_LOOKBACK_DAYS || "0",
    KALSHI_MIN_REQUEST_GAP_MS: process.env.KALSHI_MIN_REQUEST_GAP_MS || "400",
    PIPELINE_KALSHI_MARKETS_URL: process.env.PIPELINE_KALSHI_MARKETS_URL,
    PIPELINE_AUTH_TOKEN: process.env.PIPELINE_AUTH_TOKEN,
  };
}

const env = envFromProcess();
console.log(
  `auth=${kalshiAuthConfigured(env)} probe_flag=${env.KALSHI_RFQ_PROBE_ENABLED} lookback=${env.KALSHI_SPORTS_LOOKBACK_DAYS} (secrets not printed)`,
);
if (!kalshiAuthConfigured(env)) {
  console.error("Missing KALSHI_ACCESS_KEY_ID and/or KALSHI_PRIVATE_KEY_PEM");
  process.exit(2);
}

const rows = await fetchKalshiSportsParlays(env);
const rfq = rows.filter((row) => row.source === KALSHI_RFQ_SOURCE);
const twoSided = rows.filter(
  (row) =>
    row.yes_bid != null &&
    row.yes_ask != null &&
    row.yes_bid > 0 &&
    row.yes_ask < 1 &&
    row.yes_ask >= row.yes_bid,
);
console.log(`fetched ${rows.length} sports rows; rfq_overlay=${rfq.length}; two_sided=${twoSided.length}`);
for (const row of rfq) {
  console.log(
    JSON.stringify({
      market_ticker: row.market_ticker,
      source: row.source,
      yes_bid: row.yes_bid,
      yes_ask: row.yes_ask,
      yes_last: row.yes_last,
      title: (row.title || "").slice(0, 120),
    }),
  );
}

const outPath = process.env.KALSHI_RFQ_FILL_OUT || "/tmp/kalshi_rfq_fill.json";
writeFileSync(
  outPath,
  JSON.stringify(
    {
      fetched: rows.length,
      rfq_overlay: rfq.length,
      two_sided: twoSided.length,
      rfq: rfq.map((row) => ({
        market_ticker: row.market_ticker,
        yes_bid: row.yes_bid,
        yes_ask: row.yes_ask,
        yes_last: row.yes_last,
        title: row.title,
      })),
    },
    null,
    2,
  ),
);
console.log(`wrote ${outPath}`);

const url = env.PIPELINE_KALSHI_MARKETS_URL || "";
if (!url) {
  console.log("PIPELINE_KALSHI_MARKETS_URL unset — not publishing (tape is in the JSON out file)");
  process.exit(rfq.length > 0 ? 0 : 4);
}

const published = await publishKalshiMarketRows(rows, env, "KXMVE");
console.log(
  JSON.stringify({
    published: published.published,
    row_count: published.row_count,
    run_id: published.run_id,
    fetched_at: published.fetched_at,
  }),
);
process.exit(rfq.length > 0 ? 0 : 4);
