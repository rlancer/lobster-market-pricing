/**
 * Operator trail for one executor pass: every same-game two-leg book, its
 * selected legs, corr room, and why it was RFQ'd / skipped / filled.
 * Mix n>2 and cross-game stay in universe counts — they are not considered.
 */

import type { KalshiMarketRow } from "./kalshi.js";
import { isSameGameSportsTwoLeg, type MveSelectedLeg } from "./kalshi-mve.js";
import {
  PARLAY_BOOK_CORR_ROOM,
  PARLAY_MAX_ABS_PHI,
  PARLAY_MAX_ASK_OVER_INDEP,
  PARLAY_MAX_SPREAD,
  PARLAY_MIN_CORR_ROOM,
  PARLAY_UNDERDOG_MAX_COST,
  corrRoom,
  independenceJoint,
  parlayBook,
  sameSide,
  type ParlayBookId,
} from "./kalshi-parlay-filter.js";
import { selectedProb } from "./kalshi-rfq-quotes.js";

export const PARLAY_CONSIDERED_CAP = 24;
export const PARLAY_TITLE_MAX = 80;

export type ParlayConsideredStatus = "accepted" | "would_accept" | "rfq_skip" | "skipped";

export interface ParlayConsideredLeg {
  market_ticker: string;
  title: string;
  side: "yes" | "no";
  p: number | null;
}

export interface ParlayConsidered {
  market_ticker: string;
  title: string;
  legs: ParlayConsideredLeg[];
  p: number | null;
  q: number | null;
  corr_room: number | null;
  independence: number | null;
  status: ParlayConsideredStatus;
  skip: string | null;
  reason: string;
}

export interface ParlayConsideredDecision {
  market_ticker: string;
  would_accept: boolean;
  accepted: boolean;
  error: string | null;
  reasons: string[];
  yes_ask: number | null;
}

function clip(raw: string, max = PARLAY_TITLE_MAX): string {
  const text = raw.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function fmtCents(n: number): string {
  return `${(n * 100).toFixed(0)}¢`;
}

function isOpenCombo(row: KalshiMarketRow): boolean {
  return !/^(settled|finalized|closed)$/i.test(row.status);
}

function explainCode(
  code: string,
  stats: { corr_room?: number | null; yes_ask?: number | null; independence?: number | null },
): string {
  const room = stats.corr_room;
  const ask = stats.yes_ask;
  const indep = stats.independence;
  switch (code) {
    case "missing_leg_mids":
      return "No tradable prices on one or both legs";
    case "mixed_side":
      return "Mixed yes/no legs — filter requires same side";
    case "corr_room":
      return room != null
        ? `Legs are not correlated enough (corr room ${fmtCents(room)}, need ${fmtCents(PARLAY_MIN_CORR_ROOM)})`
        : `Legs are not correlated enough (corr room below ${fmtCents(PARLAY_MIN_CORR_ROOM)})`;
    case "rfq_rank":
      return "Ranked below the RFQ cap this pass";
    case "max_accepts":
      return "Not solicited — already filled this pass";
    case "max_spend":
      return "Run cash cap reached — no further accepts";
    case "spend_unknown":
      return "Live accept blocked — no spend watermark (D1 run id or KALSHI_PARLAY_SPEND_SINCE)";
    case "underdog_cost":
      return ask != null
        ? `YES ask ${fmtCents(ask)} is above the ${fmtCents(PARLAY_UNDERDOG_MAX_COST)} underdog cap`
        : `YES ask is above the ${fmtCents(PARLAY_UNDERDOG_MAX_COST)} underdog cap`;
    case "no_two_way":
      return "Makers did not quote a two-way";
    case "forbidden":
      return "Kalshi communications 401/403 (need write::trade)";
    case "no_quote_id":
      return "No single-maker quote_id";
    case "spread":
      return `Quote spread wider than ${fmtCents(PARLAY_MAX_SPREAD)}`;
    case "ask_vs_indep":
      return indep != null && ask != null
        ? `Ask ${ask.toFixed(3)} is more than ${fmtCents(PARLAY_MAX_ASK_OVER_INDEP)} above independence ${indep.toFixed(3)}`
        : `Ask is more than ${fmtCents(PARLAY_MAX_ASK_OVER_INDEP)} above independence`;
    case "phi":
      return `Implied |φ| is at least ${PARLAY_MAX_ABS_PHI} (quote already priced as correlated)`;
    case "ask":
      return "Quote ask is missing or not a live 0–1 price";
    case "not_two_leg":
      return "Not a two-leg stack";
    case "not_same_game":
      return "Not same-game";
    default:
      return code.replace(/_/g, " ");
  }
}

export function explainParlaySkip(
  codes: string[],
  stats: { corr_room?: number | null; yes_ask?: number | null; independence?: number | null } = {},
): string {
  const unique = [...new Set(codes.filter(Boolean))];
  if (unique.length === 0) return "Skipped";
  return unique.map((code) => explainCode(code, stats)).join("; ");
}

function rankStatus(status: ParlayConsideredStatus): number {
  if (status === "accepted") return 0;
  if (status === "would_accept") return 1;
  if (status === "rfq_skip") return 2;
  return 3;
}

export function listSameGameConsidered(
  combos: KalshiMarketRow[],
  comboLegs: Map<string, MveSelectedLeg[]>,
  legs: KalshiMarketRow[],
  opts?: { book?: ParlayBookId },
): ParlayConsidered[] {
  const book = opts?.book ?? parlayBook({});
  const byTicker = new Map(legs.map((row) => [row.market_ticker, row]));
  const out: ParlayConsidered[] = [];
  for (const combo of combos) {
    if (!isOpenCombo(combo)) continue;
    const spec = comboLegs.get(combo.market_ticker) ?? [];
    if (!isSameGameSportsTwoLeg(spec)) continue;
    const mappedLegs: ParlayConsideredLeg[] = spec.map((leg) => {
      const row = byTicker.get(leg.market_ticker);
      return {
        market_ticker: leg.market_ticker,
        title: clip(row?.title || row?.yes_subtitle || leg.market_ticker),
        side: leg.side,
        p: selectedProb(row, leg.side),
      };
    });
    const p = mappedLegs[0]?.p ?? null;
    const q = mappedLegs[1]?.p ?? null;
    const sides = spec.map((leg) => leg.side);
    const room = p != null && q != null ? corrRoom(p, q) : null;
    const independence = p != null && q != null ? independenceJoint(p, q) : null;
    let skip: string | null = null;
    if (p == null || q == null) skip = "missing_leg_mids";
    else if (!sameSide(sides)) skip = "mixed_side";
    else if (
      book === PARLAY_BOOK_CORR_ROOM
      && room != null
      && room < PARLAY_MIN_CORR_ROOM - 1e-12
    ) {
      skip = "corr_room";
    }
    const eligible = book === PARLAY_BOOK_CORR_ROOM
      ? "Eligible — ranked for RFQ by corr room"
      : "Eligible — ranked for RFQ by cheapest independence";
    const reason = skip
      ? explainParlaySkip([skip], { corr_room: room, independence })
      : eligible;
    out.push({
      market_ticker: combo.market_ticker,
      title: clip(combo.title || combo.market_ticker),
      legs: mappedLegs,
      p,
      q,
      corr_room: room,
      independence,
      status: "skipped",
      skip,
      reason,
    });
  }
  out.sort((a, b) => {
    if (book !== PARLAY_BOOK_CORR_ROOM) {
      const ia = a.independence ?? Number.POSITIVE_INFINITY;
      const ib = b.independence ?? Number.POSITIVE_INFINITY;
      if (ia !== ib) return ia - ib;
    } else {
      const roomA = a.corr_room ?? -1;
      const roomB = b.corr_room ?? -1;
      if (roomB !== roomA) return roomB - roomA;
    }
    return a.market_ticker < b.market_ticker ? -1 : a.market_ticker > b.market_ticker ? 1 : 0;
  });
  return out;
}

export function annotateParlayConsidered(
  rows: ParlayConsidered[],
  opts: {
    targetTickers: ReadonlySet<string>;
    decisions: ParlayConsideredDecision[];
    live: boolean;
    acceptedCount: number;
    maxAccepts: number;
    spendBlocked?: "max_spend" | "spend_unknown" | null;
  },
): ParlayConsidered[] {
  const byDecision = new Map(opts.decisions.map((row) => [row.market_ticker, row]));
  const annotated = rows.map((row) => {
    const decision = byDecision.get(row.market_ticker);
    if (decision) {
      const stats = {
        corr_room: row.corr_room,
        independence: row.independence,
        yes_ask: decision.yes_ask,
      };
      if (decision.accepted) {
        return {
          ...row,
          status: "accepted" as const,
          skip: null,
          reason: decision.yes_ask != null
            ? `Accepted YES at ask ${decision.yes_ask.toFixed(3)}`
            : "Accepted YES",
        };
      }
      if (decision.would_accept) {
        return {
          ...row,
          status: "would_accept" as const,
          skip: null,
          reason: opts.live
            ? "Would accept"
            : "Would accept — dry-run deleted the RFQ",
        };
      }
      const codes = decision.error
        ? [decision.error, ...decision.reasons]
        : (decision.reasons.length ? decision.reasons : ["rfq_skip"]);
      return {
        ...row,
        status: "rfq_skip" as const,
        skip: codes[0] ?? "rfq_skip",
        reason: explainParlaySkip(codes, stats),
      };
    }
    if (opts.targetTickers.has(row.market_ticker)) {
      if (!row.skip && opts.spendBlocked) {
        return {
          ...row,
          status: "skipped" as const,
          skip: opts.spendBlocked,
          reason: explainParlaySkip([opts.spendBlocked]),
        };
      }
      if (!row.skip && opts.live && opts.acceptedCount >= opts.maxAccepts) {
        return {
          ...row,
          status: "skipped" as const,
          skip: "max_accepts",
          reason: explainParlaySkip(["max_accepts"]),
        };
      }
      return row;
    }
    if (row.skip) return row;
    return {
      ...row,
      skip: "rfq_rank",
      reason: explainParlaySkip(["rfq_rank"]),
    };
  });
  annotated.sort((a, b) => {
    const status = rankStatus(a.status) - rankStatus(b.status);
    if (status !== 0) return status;
    const roomA = a.corr_room ?? -1;
    const roomB = b.corr_room ?? -1;
    if (roomB !== roomA) return roomB - roomA;
    return a.market_ticker < b.market_ticker ? -1 : a.market_ticker > b.market_ticker ? 1 : 0;
  });
  return annotated.slice(0, PARLAY_CONSIDERED_CAP);
}
