/**
 * Research-page helpers for curated Kalshi event markets joined by
 * related_symbol (SPY, TLT, META, BTC-USD, …). Ranking mirrors the loader's
 * volume-then-soonest-close preference so the rail stays skimable.
 */

/** Dual-class / synonym keys so Alphabet events linked as GOOGL also show on GOOG. */
export function kalshiRelatedSymbolKeys(ticker: string): string[] {
  const t = String(ticker || "").trim().toUpperCase();
  if (!t) return [];
  if (t === "GOOG" || t === "GOOGL") return ["GOOG", "GOOGL"];
  return [t];
}

export interface KalshiMarketBrief {
  series_ticker: string;
  market_ticker: string;
  event_ticker: string | null;
  title: string;
  yes_subtitle: string | null;
  theme: string;
  status: string;
  yes_bid: number | null;
  yes_ask: number | null;
  yes_last: number | null;
  volume: number | null;
  volume_24h: number | null;
  open_interest: number | null;
  close_time: string | null;
  related_symbol: string | null;
  /** Public Kalshi series page when we can build one. */
  url: string | null;
}

/** Series landing page on kalshi.com (event-level slugs are not in the lake). */
export function kalshiSeriesUrl(seriesTicker: string | null | undefined): string | null {
  const series = String(seriesTicker || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{1,31}$/.test(series)) return null;
  return `https://kalshi.com/markets/${series}`;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? null : n;
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Map a lake / SQL row into a research brief item. */
export function mapKalshiMarketBrief(row: Record<string, unknown>): KalshiMarketBrief | null {
  const market_ticker = String(row.market_ticker || "").trim().toUpperCase();
  const series_ticker = String(row.series_ticker || "").trim().toUpperCase();
  const title = String(row.title || "").trim() || market_ticker;
  if (!market_ticker || !series_ticker) return null;
  return {
    series_ticker,
    market_ticker,
    event_ticker: strOrNull(row.event_ticker)?.toUpperCase() ?? null,
    title,
    yes_subtitle: strOrNull(row.yes_subtitle),
    theme: strOrNull(row.theme) || "other",
    status: strOrNull(row.status) || "unknown",
    yes_bid: numOrNull(row.yes_bid),
    yes_ask: numOrNull(row.yes_ask),
    yes_last: numOrNull(row.yes_last),
    volume: numOrNull(row.volume),
    volume_24h: numOrNull(row.volume_24h),
    open_interest: numOrNull(row.open_interest),
    close_time: strOrNull(row.close_time),
    related_symbol: strOrNull(row.related_symbol)?.toUpperCase() ?? null,
    url: kalshiSeriesUrl(series_ticker),
  };
}

/** Prefer liquid / soon-to-close markets (same order as loader rankKalshiMarkets). */
export function rankResearchKalshiMarkets(rows: KalshiMarketBrief[]): KalshiMarketBrief[] {
  return [...rows].sort((a, b) => {
    const volA = a.volume_24h ?? a.volume ?? 0;
    const volB = b.volume_24h ?? b.volume ?? 0;
    if (volB !== volA) return volB - volA;
    const closeA = a.close_time || "9999";
    const closeB = b.close_time || "9999";
    if (closeA !== closeB) return closeA < closeB ? -1 : 1;
    return a.market_ticker < b.market_ticker ? -1 : a.market_ticker > b.market_ticker ? 1 : 0;
  });
}

/**
 * Drop settled / past-close markets so the research rail focuses on live odds.
 * Unknown status with a future (or missing) close_time is kept.
 */
export function isLiveKalshiMarket(
  row: KalshiMarketBrief,
  nowMs = Date.now(),
): boolean {
  const status = row.status.toLowerCase();
  if (status === "closed" || status === "settled" || status === "finalized") {
    return false;
  }
  if (row.close_time) {
    const t = Date.parse(row.close_time);
    if (Number.isFinite(t) && t < nowMs) return false;
  }
  return true;
}

/** Latest-wins rows → ranked live briefs, capped. */
export function selectResearchKalshiMarkets(
  rows: Record<string, unknown>[],
  limit: number,
  nowMs = Date.now(),
): KalshiMarketBrief[] {
  const lim = Math.max(1, Math.min(50, Math.floor(limit)));
  const mapped: KalshiMarketBrief[] = [];
  for (const row of rows) {
    const brief = mapKalshiMarketBrief(row);
    if (brief && isLiveKalshiMarket(brief, nowMs)) mapped.push(brief);
  }
  return rankResearchKalshiMarkets(mapped).slice(0, lim);
}

/** Implied YES probability for display (prefer last, else mid bid/ask). */
export function kalshiYesProb(row: KalshiMarketBrief): number | null {
  if (row.yes_last != null && Number.isFinite(row.yes_last)) return row.yes_last;
  if (
    row.yes_bid != null &&
    row.yes_ask != null &&
    Number.isFinite(row.yes_bid) &&
    Number.isFinite(row.yes_ask)
  ) {
    return (row.yes_bid + row.yes_ask) / 2;
  }
  if (row.yes_bid != null && Number.isFinite(row.yes_bid)) return row.yes_bid;
  if (row.yes_ask != null && Number.isFinite(row.yes_ask)) return row.yes_ask;
  return null;
}

/** Compact text block for Copilot / Lobster commentary (YES % + title). */
export function summarizeKalshiForResearch(
  items: KalshiMarketBrief[],
  opts?: { limit?: number },
): string | null {
  const lim = Math.max(1, Math.min(12, Math.floor(opts?.limit ?? 6)));
  const lines: string[] = [];
  for (const item of items.slice(0, lim)) {
    const yes = kalshiYesProb(item);
    const pct = yes != null && Number.isFinite(yes) ? `${Math.round(yes * 100)}% YES` : "YES n/a";
    const theme = item.theme && item.theme !== "other" ? ` [${item.theme}]` : "";
    const subtitle = item.yes_subtitle ? ` — ${item.yes_subtitle}` : "";
    lines.push(`- ${pct}: ${item.title}${subtitle}${theme} (${item.market_ticker})`);
  }
  if (!lines.length) return null;
  return ["Related Kalshi event markets (curated; use in fundamental / catalyst context):", ...lines].join("\n");
}
