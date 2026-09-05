/** Calendar as-of date (`YYYY-MM-DD`) for replaying lake/P&L windows. */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDateString(raw: string): boolean {
  const m = ISO_DATE.exec(raw);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year
    && utc.getUTCMonth() === month - 1
    && utc.getUTCDate() === day
  );
}

/**
 * Parse a shareable as-of date. Invalid calendar days are rejected.
 * Dates after `today` clamp to `today` so the picker cannot jump into the future.
 */
export function parseAsOfDate(
  raw: string | null | undefined,
  today: string,
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!isIsoDateString(trimmed)) return null;
  return trimmed > today ? today : trimmed;
}

export function parseAsOfSearch(
  raw: unknown,
  today: string,
): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return parseAsOfDate(raw, today) ?? undefined;
}

export function isHistoricalAsOf(
  asOf: string | null | undefined,
  today: string,
): boolean {
  return Boolean(asOf && asOf < today);
}

/** Noon-ish UTC instant that still maps to `ymd` on the ET calendar. */
export function asOfInstant(ymd: string): Date {
  return new Date(`${ymd}T16:00:00.000Z`);
}
