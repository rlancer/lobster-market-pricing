/**
 * Sports parlay (multivariate) ingest helpers.
 *
 * Kalshi MVE combo markets carry `mve_collection_ticker` + `mve_selected_legs`.
 * The existing kalshi_markets stream schema has no extra columns, so the
 * collection and legs are stored in `category` as a documented encoding:
 *   mve|{collection}|{yes|no}:{LEG_TICKER}@{EVENT},{yes|no}:{LEG_TICKER}@{EVENT},…
 * Event tickers are optional (`yes:LEG` still parses) so older lake rows work.
 * Combo rows use theme=sports and market_type=multivariate. Leg contracts are
 * published as their own sports rows so independence scoring can join on
 * market_ticker. Do not scrape the full sports catalog — only MVE combos
 * (open, plus settled/closed in the lookback window) and the legs those
 * combos actually select. Daily candlesticks carry the history.
 */

export const MVE_CATEGORY_PREFIX = "mve|";

export const SPORTS_SERIES_PREFIX =
  /^KX(NFL|NBA|MLB|NHL|MLS|WNBA|NCAA|NCAAF|NCAAB|NCAAW|CFB|CBB|EPL|UCL|UFC|ATP|WTA|PGA|FIFA|SOCCER|PARLAY)/i;

export const SPORTS_TEXT_RE =
  /\b(NFL|NBA|MLB|NHL|MLS|WNBA|NCAA|NCAAF|NCAAB|CFB|CBB|EPL|UCL|UFC|ATP|WTA|PGA|FIFA|SOCCER|FOOTBALL|BASKETBALL|BASEBALL|HOCKEY|TENNIS|GOLF|MMA|SPORTS?|RAVENS|JAGUARS|CHIEFS|BILLS|COWBOYS|YANKEES|LAKERS|CELTICS)\b/i;

export const CRYPTO_LEG_RE =
  /^KX(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE|ZEC|ADA|AVAX|DOT|LINK|MATIC|SHIB|PEPE|WIF|SUI|APT|NEAR|TON|TRX|LTC|BCH|BONK|SEI|ONDO|TAO)(15M|D)?(?:-|$)/i;

export type MveLegKind = "sports" | "crypto" | "other";
export type MveTapeKind = "sports" | "crypto_mve" | "mixed";

export function mveLegKind(ticker: string): MveLegKind {
  const t = ticker.trim().toUpperCase();
  if (CRYPTO_LEG_RE.test(t)) return "crypto";
  if (SPORTS_SERIES_PREFIX.test(t)) return "sports";
  return "other";
}

export function mveTapeKind(legTickers: string[]): MveTapeKind {
  let sports = false;
  let crypto = false;
  for (const ticker of legTickers) {
    const kind = mveLegKind(ticker);
    if (kind === "sports") sports = true;
    else if (kind === "crypto") crypto = true;
  }
  if (sports && crypto) return "mixed";
  if (crypto) return "crypto_mve";
  return "sports";
}

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

function packCategoryToken(raw: string): string {
  return raw.replaceAll("|", "").replaceAll("@", "").replaceAll(",", "").toUpperCase();
}

export function encodeMveCategory(collection: string, legs: MveSelectedLeg[]): string {
  const col = packCategoryToken(collection || "unknown") || "UNKNOWN";
  const packed = legs.map((leg) => {
    const ticker = packCategoryToken(leg.market_ticker);
    const event = packCategoryToken(leg.event_ticker || "");
    const side = leg.side === "no" ? "no" : "yes";
    return event ? `${side}:${ticker}@${event}` : `${side}:${ticker}`;
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
    const restLeg = part.slice(idx + 1).trim().toUpperCase();
    const at = restLeg.indexOf("@");
    const market_ticker = (at >= 0 ? restLeg.slice(0, at) : restLeg).trim();
    const event_ticker = at >= 0 ? restLeg.slice(at + 1).trim() || null : null;
    if (!market_ticker || seen.has(market_ticker)) continue;
    seen.add(market_ticker);
    legs.push({ event_ticker, market_ticker, side });
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
  const tape = mveTapeKind(legs.map((leg) => leg.market_ticker));
  if (tape === "crypto_mve") return false;
  if (tape === "sports" || tape === "mixed") return true;
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

/** NFL-style game slug: 26SEP13ATLPIT (date + two 3-letter teams). */
const SPORTS_GAME_SLUG_RE = /(\d{2}[A-Z]{3}\d{2}[A-Z]{6})/;

export function sportsGameKey(ticker: string, eventTicker?: string | null): string {
  const blob = `${eventTicker || ""}-${ticker}`.toUpperCase();
  const game = blob.match(SPORTS_GAME_SLUG_RE);
  if (game) return game[1]!;
  if (eventTicker && eventTicker.trim()) return eventTicker.trim().toUpperCase();
  return eventPrefixFromTicker(ticker);
}

export function parlayGameGroup(eventTickers: string[]): "same_game" | "cross_game" | "mixed" {
  const events = [...new Set(eventTickers.map((e) => e.trim().toUpperCase()).filter(Boolean))];
  if (events.length <= 1) return "same_game";
  if (events.length === eventTickers.filter(Boolean).length) return "cross_game";
  return "mixed";
}

function isSportsTwoLeg(legs: MveSelectedLeg[]): boolean {
  if (legs.length !== 2) return false;
  const tickers = legs.map((leg) => leg.market_ticker);
  if (mveTapeKind(tickers) !== "sports") return false;
  return tickers.every((ticker) => mveLegKind(ticker) === "sports");
}

/** Live RFQ target: two sports legs on the same game (event_ticker or NFL-style slug). */
export function isSameGameSportsTwoLeg(legs: MveSelectedLeg[]): boolean {
  if (!isSportsTwoLeg(legs)) return false;
  const games = legs.map((leg) => sportsGameKey(leg.market_ticker, leg.event_ticker));
  return parlayGameGroup(games) === "same_game";
}

/** Two sports legs on different games — independence is the fair joint. */
export function isCrossGameSportsTwoLeg(legs: MveSelectedLeg[]): boolean {
  if (!isSportsTwoLeg(legs)) return false;
  const games = legs.map((leg) => sportsGameKey(leg.market_ticker, leg.event_ticker));
  return parlayGameGroup(games) === "cross_game";
}
