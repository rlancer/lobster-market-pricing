/**
 * Shared entity classification + in-app / external destinations.
 * Used by EntityLink and SQL result auto-linking.
 */

export type EntityKind = 'security' | 'kalshi_market' | 'kalshi_series';

export interface ClassifiedEntity {
  kind: EntityKind;
  id: string;
}

const SLASH_ROOTS: Record<string, string> = {
  '/ES': 'ES=F',
  '/NQ': 'NQ=F',
  '/YM': 'YM=F',
  '/RTY': 'RTY=F',
  '/VX': 'VX=F',
  '/CL': 'CL=F',
  '/GC': 'GC=F',
  '/SI': 'SI=F',
  '/ZB': 'ZB=F',
  '/ZN': 'ZN=F',
  '/ZF': 'ZF=F',
  '/ZT': 'ZT=F',
  '/6E': '6E=F',
  '/6J': '6J=F',
  '/6B': '6B=F',
};

/** Frontend mirror of worker parseTickerParam. */
export function parseTickerParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toUpperCase().replace(/[\s]+/g, '');
  const fromSlash = SLASH_ROOTS[t];
  if (fromSlash) return fromSlash;
  if (/^\^[A-Z][A-Z0-9]{0,10}$/.test(t)) return t;
  if (/^[A-Z0-9]{1,6}=F$/.test(t)) return t;
  if (/^[A-Z][A-Z0-9.\-]{0,11}$/.test(t)) return t;
  return null;
}

/**
 * Mirror worker parseKalshiParam — curated series/markets are KX-prefixed.
 * Keep in sync with research-kalshi.ts (KX… only so BTC-USD stays a security).
 */
export function parseKalshiParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!/^KX[A-Z0-9.]{1,45}(-[A-Z0-9.]{1,24}){0,4}$/.test(t)) return null;
  if (t.length < 3 || t.length > 64) return null;
  return t;
}

export function kalshiSeriesUrl(seriesTicker: string | null | undefined): string | null {
  const series = String(seriesTicker || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{1,31}$/.test(series)) return null;
  return `https://kalshi.com/markets/${series}`;
}

/**
 * Classify a free-form ticker / market id for linking.
 * Kalshi markets (hyphenated KX…) win over equity parse; series roots next.
 */
export function classifyEntity(raw: string | null | undefined): ClassifiedEntity | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const kalshi = parseKalshiParam(trimmed);
  if (kalshi) {
    if (kalshi.includes('-')) {
      return { kind: 'kalshi_market', id: kalshi };
    }
    return { kind: 'kalshi_series', id: kalshi };
  }
  const security = parseTickerParam(trimmed);
  if (security) return { kind: 'security', id: security };
  return null;
}

/** In-app research path for a classified entity. */
export function entityResearchPath(entity: ClassifiedEntity): string {
  if (entity.kind === 'security') {
    return `/research/${encodeURIComponent(entity.id)}`;
  }
  return `/research/kalshi/${encodeURIComponent(entity.id)}`;
}

/** Column names that typically hold linkable entities in SQL / lake results. */
export const ENTITY_COLUMN_RE =
  /^(symbol|ticker|holding_symbol|related_symbol|market_ticker|series_ticker|underlying)$/i;

export function columnLooksLikeEntity(column: string): boolean {
  return ENTITY_COLUMN_RE.test(column.trim());
}
