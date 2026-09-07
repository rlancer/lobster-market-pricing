/**
 * CFE VX monthly symbology shared by the Floor tape and the VIX term page.
 *
 * Quote symbols look like VXU26 (root + month code + two-digit year).
 * Settlement CSV monthals look like VX/U6; weeklies (VX34/Q6) are ignored
 * on the term structure.
 */

export const VX_MONTH_CODES: Readonly<Record<string, string>> = {
  F: "Jan",
  G: "Feb",
  H: "Mar",
  J: "Apr",
  K: "May",
  M: "Jun",
  N: "Jul",
  Q: "Aug",
  U: "Sep",
  V: "Oct",
  X: "Nov",
  Z: "Dec",
};

export const MONTHLY_VX_QUOTE_RE = /^VX([FGHJKMNQUVXZ])(\d{2})$/;
export const MONTHLY_VX_SETTLE_RE = /^VX\/([FGHJKMNQUVXZ])(\d)$/;

export function isMonthlyVxQuote(symbol: string): boolean {
  return MONTHLY_VX_QUOTE_RE.test(symbol.trim().toUpperCase());
}

export function isMonthlyVxSettle(symbol: string): boolean {
  return MONTHLY_VX_SETTLE_RE.test(symbol.trim().toUpperCase());
}

/** Friendly tape label for a monthly VX quote symbol (`VXU26` → `VX Sep'26`). */
export function vxFuturesDisplayName(contractSymbol: string): string {
  const month = vxMonthLabel(contractSymbol);
  if (!month || month === contractSymbol.trim().toUpperCase()) {
    return contractSymbol.trim().toUpperCase() || "VX";
  }
  return `VX ${month}`;
}

/** Calendar month on a monthly VX quote (`VXU26` → `Sep'26`). */
export function vxMonthLabel(contractSymbol: string): string {
  const symbol = contractSymbol.trim().toUpperCase();
  const match = MONTHLY_VX_QUOTE_RE.exec(symbol);
  if (!match) return symbol;
  const month = VX_MONTH_CODES[match[1]!] ?? match[1]!;
  return `${month}'${match[2]}`;
}

/**
 * Map a monthly settlement symbol (`VX/U6`) onto the delayed-quote form
 * (`VXU26`). Weeklies return null. Year is the decade of `asOfYear` plus the
 * single CFE year digit, wrapping forward when that would land in the past.
 */
export function vxSettlementToQuote(
  contractSymbol: string,
  asOfYear: number,
): string | null {
  const match = MONTHLY_VX_SETTLE_RE.exec(contractSymbol.trim().toUpperCase());
  if (!match) return null;
  const digit = Number(match[2]);
  if (!Number.isFinite(digit)) return null;
  let year = Math.floor(asOfYear / 10) * 10 + digit;
  if (year < asOfYear - 2) year += 10;
  return `VX${match[1]}${String(year).slice(-2)}`;
}

const CASH_VIX_INDEXES = new Set(["^VIX", "^VIX9D", "^VIX3M", "^VVIX"]);

/** Cash vol indexes and monthly VX quotes belong on `/vix`, not ticker research. */
export function isVixPageTicker(ticker: string): boolean {
  const t = ticker.trim().toUpperCase();
  const index = t.startsWith("^") ? t : `^${t}`;
  return CASH_VIX_INDEXES.has(index) || isMonthlyVxQuote(t);
}
