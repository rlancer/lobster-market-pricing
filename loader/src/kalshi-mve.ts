/**
 * Sports parlay (multivariate) ingest helpers.
 *
 * Kalshi MVE combo markets carry `mve_collection_ticker` + `mve_selected_legs`.
 * The existing kalshi_markets stream schema has no extra columns, so the
 * collection and legs are stored in `category` as a documented encoding:
 *   mve|{collection}|{yes|no}:{LEG_TICKER},{yes|no}:{LEG_TICKER},…
 * Combo rows use theme=sports and market_type=multivariate. Leg contracts are
 * published as their own sports rows so independence scoring can join on
 * market_ticker. Do not scrape the full sports catalog — only MVE combos
 * (open, plus settled/closed in the lookback window) and the legs those
 * combos actually select. Daily candlesticks carry the history.
 */

export const MVE_CATEGORY_PREFIX = "mve|";

export const SPORTS_SERIES_PREFIX =
  /^KX(NFL|NBA|MLB|NHL|MLS|WNBA|NCAA|NCAAF|NCAAB|NCAAW|CFB|CBB|EPL|UCL|UFC|ATP|WTA|PGA|FIFA|SOCCER|MVE|PARLAY)/i;

export const SPORTS_TEXT_RE =
  /\b(NFL|NBA|MLB|NHL|MLS|WNBA|NCAA|NCAAF|NCAAB|CFB|CBB|EPL|UCL|UFC|ATP|WTA|PGA|FIFA|SOCCER|FOOTBALL|BASKETBALL|BASEBALL|HOCKEY|TENNIS|GOLF|MMA|SPORTS?|RAVENS|JAGUARS|CHIEFS|BILLS|COWBOYS|YANKEES|LAKERS|CELTICS)\b/i;

export interface MveSelectedLeg {
  event_ticker: string | null;
  market_ticker: string;
  side: "yes" | "no";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

export function seriesTickerFromMarketTicker(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  const m = t.match(/^(KX[A-Z]+)/);
  return m ? m[1]! : t;
}

export function parseMveSelectedLegs(raw: unknown): MveSelectedLeg[] {
  const rec = asRecord(raw);
  const legs = rec?.mve_selected_legs;
  if (!Array.isArray(legs)) return [];
  const out: MveSelectedLeg[] = [];
  const seen = new Set<string>();
  for (const item of legs) {
    const leg = asRecord(item);
    if (!leg) continue;
    const market_ticker = strip(leg.market_ticker).toUpperCase();
    if (!market_ticker || seen.has(market_ticker)) continue;
    seen.add(market_ticker);
    const side = strip(leg.side).toLowerCase() === "no" ? "no" : "yes";
    const event_ticker = strip(leg.event_ticker).toUpperCase() || null;
    out.push({ event_ticker, market_ticker, side });
  }
  return out;
}

export function mveCollectionTicker(raw: unknown): string {
  const rec = asRecord(raw);
  return strip(rec?.mve_collection_ticker).toUpperCase();
}

export function encodeMveCategory(collection: string, legs: MveSelectedLeg[]): string {
  const col = (collection || "unknown").replaceAll("|", "").toUpperCase() || "UNKNOWN";
  const packed = legs.map((leg) => {
    const ticker = leg.market_ticker.replaceAll("|", "").toUpperCase();
    return `${leg.side === "no" ? "no" : "yes"}:${ticker}`;
  });
  return `${MVE_CATEGORY_PREFIX}${col}|${packed.join(",")}`;
}

export function parseMveCategory(category: string | null | undefined): {
  collection: string;
  legs: MveSelectedLeg[];
} | null {
  const raw = strip(category);
  if (!raw.startsWith(MVE_CATEGORY_PREFIX)) return null;
  const rest = raw.slice(MVE_CATEGORY_PREFIX.length);
  const split = rest.indexOf("|");
  if (split < 0) return null;
  const collection = rest.slice(0, split).toUpperCase();
  const packed = rest.slice(split + 1);
  const legs: MveSelectedLeg[] = [];
  const seen = new Set<string>();
  for (const part of packed.split(",")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const side = part.slice(0, idx).toLowerCase() === "no" ? "no" : "yes";
    const market_ticker = part.slice(idx + 1).trim().toUpperCase();
    if (!market_ticker || seen.has(market_ticker)) continue;
    seen.add(market_ticker);
    legs.push({ event_ticker: null, market_ticker, side });
  }
  if (legs.length < 2) return null;
  return { collection, legs };
}

export function isSportsParlayCandidate(
  raw: unknown,
  investingSeries: ReadonlySet<string>,
): boolean {
  const rec = asRecord(raw);
  if (!rec) return false;
  const series = strip(rec.series_ticker).toUpperCase()
    || seriesTickerFromMarketTicker(strip(rec.ticker).toUpperCase());
  if (series && investingSeries.has(series)) return false;
  const legs = parseMveSelectedLegs(raw);
  if (legs.length < 2) return false;
  const collection = mveCollectionTicker(raw);
  const blob = [
    series,
    collection,
    strip(rec.title),
    strip(rec.category),
    strip(rec.yes_sub_title) || strip(rec.subtitle),
  ].join(" ");
  if (SPORTS_TEXT_RE.test(blob)) return true;
  if (SPORTS_SERIES_PREFIX.test(series) || SPORTS_SERIES_PREFIX.test(collection)) return true;
  return strip(rec.category).toLowerCase() === "sports";
}

export function eventPrefixFromTicker(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  const trimmed = t.replace(/-[^-]+$/, "");
  return trimmed || t;
}

export function parlayGameGroup(eventTickers: string[]): "same_game" | "cross_game" | "mixed" {
  const events = [...new Set(eventTickers.map((e) => e.trim().toUpperCase()).filter(Boolean))];
  if (events.length <= 1) return "same_game";
  if (events.length === eventTickers.filter(Boolean).length) return "cross_game";
  return "mixed";
}
