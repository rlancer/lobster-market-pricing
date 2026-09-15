/**
 * Kalshi 0/1 settlement prints for the sports-parlay tape.
 *
 * Quote history stays on candles / RFQ two-ways. Outcomes are a distinct
 * `source=kalshi_settlement` row so latest-wins research can see the result
 * without treating 0/1 as a tradable mid. The parlay backtest grades
 * evaluateParlayQuote against these rows (or both legs when the combo
 * result is missing).
 */

export const KALSHI_SETTLEMENT_SOURCE = "kalshi_settlement";

export function isKalshiSettledStatus(status: string | null | undefined): boolean {
  return /^(settled|finalized)$/i.test(String(status ?? "").trim());
}

export function isKalshiSettlementSource(source: string | null | undefined): boolean {
  return String(source ?? "").trim().toLowerCase() === KALSHI_SETTLEMENT_SOURCE;
}

/** Settlement 0/1 prints are outcomes, not quotes. */
export function looksLikeSettlementPrint(
  bid: number | null | undefined,
  ask: number | null | undefined,
  last: number | null | undefined,
): boolean {
  const binary = (v: number | null | undefined) => v == null || v === 0 || v === 1;
  if (last !== 0 && last !== 1) return false;
  return binary(bid) && binary(ask);
}

export function kalshiResultYes(result: unknown): 0 | 1 | null {
  const raw = String(result ?? "").trim().toLowerCase();
  if (raw === "yes" || raw === "1") return 1;
  if (raw === "no" || raw === "0") return 0;
  return null;
}

export function settlementYes(row: {
  yes_bid?: number | null;
  yes_ask?: number | null;
  yes_last?: number | null;
  status?: string | null;
  source?: string | null;
  result?: unknown;
}): 0 | 1 | null {
  const fromResult = kalshiResultYes(row.result);
  if (fromResult != null && (isKalshiSettledStatus(row.status) || isKalshiSettlementSource(row.source))) {
    return fromResult;
  }
  const last = row.yes_last;
  if (last !== 0 && last !== 1) return null;
  if (
    isKalshiSettlementSource(row.source)
    || isKalshiSettledStatus(row.status)
    || looksLikeSettlementPrint(row.yes_bid, row.yes_ask, last)
  ) {
    return last;
  }
  return null;
}

export function settlementFetchedAt(row: {
  close_time?: string | null;
  expiration_time?: string | null;
  fetched_at?: string | null;
}): string | undefined {
  const close = String(row.close_time ?? "").trim();
  if (close) return close;
  const exp = String(row.expiration_time ?? "").trim();
  if (exp) return exp;
  const fetched = String(row.fetched_at ?? "").trim();
  return fetched || undefined;
}

export function asSettlementSnapshot<T extends {
  status: string;
  yes_bid: number | null;
  yes_ask: number | null;
  yes_last: number | null;
  no_bid?: number | null;
  no_ask?: number | null;
  source: string;
  fetched_at?: string;
  close_time?: string | null;
  expiration_time?: string | null;
  result?: unknown;
}>(row: T): T | null {
  const yes = settlementYes(row);
  if (yes == null) return null;
  const fetched_at = settlementFetchedAt(row);
  return {
    ...row,
    status: "settled",
    yes_bid: yes,
    yes_ask: yes,
    yes_last: yes,
    no_bid: 1 - yes,
    no_ask: 1 - yes,
    source: KALSHI_SETTLEMENT_SOURCE,
    ...(fetched_at ? { fetched_at } : {}),
  };
}

/** Combo YES pays only when every selected side happens. */
export function inferComboSettlement(
  legs: Array<{ side: "yes" | "no"; settlement: 0 | 1 | null }>,
): 0 | 1 | null {
  if (legs.length < 2) return null;
  let all = true;
  for (const leg of legs) {
    if (leg.settlement !== 0 && leg.settlement !== 1) return null;
    const selectedHit = leg.side === "yes" ? leg.settlement === 1 : leg.settlement === 0;
    if (!selectedHit) all = false;
  }
  return all ? 1 : 0;
}
