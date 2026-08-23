/**
 * Structured suggested trades — shared by live chat, share, and timeline.
 * Dense rows (not cards): bias/conviction tokens + structure + optional legs.
 *
 * Legs are formal: instrument option|equity (stock/ETF), side buy/sell
 * (long/short), optional qty. Worker normalize always sets instrument;
 * optional here so legacy share payloads still typecheck.
 *
 * For signed-in chat owners, suggest_trades auto-opens paper positions.
 * Track remains for share/timeline viewers (or when auto-mark failed).
 */

import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@astryxdesign/core';
import { api } from './api';
import { authClient } from './auth';

export type TradeBias = 'bullish' | 'bearish' | 'neutral';
export type TradeConviction = 'high' | 'medium' | 'low';
export type OptionRight = 'call' | 'put';
export type TradeSide = 'buy' | 'sell';
export type LegInstrument = 'option' | 'equity';

/**
 * Flat leg shape for UI + API wire.
 * Prefer instrument + (for options) right + strike|strike_rel.
 */
export interface TradeLeg {
  instrument?: LegInstrument;
  side: TradeSide;
  qty?: number;
  symbol?: string;
  right?: OptionRight;
  strike?: number;
  strike_rel?: string;
  expiration?: string;
  dte?: number;
}

export interface SuggestedTrade {
  ticker: string;
  bias: TradeBias;
  conviction: TradeConviction;
  structure: string;
  legs?: TradeLeg[];
  rationale: string;
  liquidity?: string;
}

export interface SuggestedTrades {
  trades: SuggestedTrade[];
  skip_reason?: string;
}

function resolveInstrument(leg: TradeLeg): LegInstrument {
  if (leg.instrument === 'option' || leg.instrument === 'equity') return leg.instrument;
  if (leg.right || leg.strike != null || leg.strike_rel) return 'option';
  return 'equity';
}

export function formatTradeLeg(leg: TradeLeg): string {
  const qty = leg.qty != null ? `${leg.qty} ` : '';
  const sym = leg.symbol ? ` ${leg.symbol}` : '';
  if (resolveInstrument(leg) === 'equity') {
    return `${leg.side} ${qty}shares${sym}`.replace(/\s+/g, ' ').trim();
  }
  const strike = leg.strike != null
    ? String(leg.strike)
    : (leg.strike_rel ?? '?');
  const tenor = leg.expiration
    ? leg.expiration + (leg.dte != null ? ` (${leg.dte}d)` : '')
    : (leg.dte != null ? `${leg.dte}d` : '');
  const right = leg.right ?? '?';
  const body = `${leg.side} ${qty}${strike} ${right}${sym}`;
  return `${body.replace(/\s+/g, ' ').trim()}${tenor ? ` · ${tenor}` : ''}`;
}

function biasLabel(bias: TradeBias): string {
  return bias[0]!.toUpperCase() + bias.slice(1);
}

function tradeTrackable(trade: SuggestedTrade): boolean {
  if (!trade.legs?.length) return false;
  return trade.legs.every((leg) => {
    if (resolveInstrument(leg) === 'equity') return true;
    return Boolean(leg.right && leg.strike != null && leg.expiration);
  });
}

function matchesChatPosition(
  trade: SuggestedTrade,
  chatId: string | null | undefined,
  positions: Array<{ chat_id: string | null; ticker: string; structure: string }>,
): boolean {
  if (!chatId) return false;
  return positions.some(
    (p) => p.chat_id === chatId && p.ticker === trade.ticker && p.structure === trade.structure,
  );
}

function TrackTradeButton({
  trade,
  tradeIndex,
  chatId,
  alreadyTracked,
  onTracked,
}: {
  trade: SuggestedTrade;
  tradeIndex: number;
  chatId?: string | null;
  alreadyTracked: boolean;
  onTracked: () => void;
}) {
  const { data: session } = authClient.useSession();
  const signedIn = Boolean(session?.user);
  const [state, setState] = useState<'idle' | 'busy' | 'tracked' | 'error'>(
    alreadyTracked ? 'tracked' : 'idle',
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (alreadyTracked) setState('tracked');
  }, [alreadyTracked]);

  if (!signedIn) return null;
  if (!tradeTrackable(trade)) {
    return (
      <span className="ai-trade-track-note" title="Needs absolute option strikes and expirations from the lake">
        Not markable
      </span>
    );
  }

  if (state === 'tracked' || alreadyTracked) {
    return (
      <Link to="/portfolio" className="ai-trade-tracked">
        In portfolio
      </Link>
    );
  }

  return (
    <span className="ai-trade-track">
      <Button
        variant="ghost"
        size="sm"
        label={state === 'busy' ? 'Tracking…' : 'Add to portfolio'}
        isDisabled={state === 'busy'}
        onClick={() => {
          setState('busy');
          setError(null);
          void api.trackTrade({
            trade,
            trade_index: tradeIndex,
            chat_id: chatId ?? undefined,
          })
            .then(() => {
              setState('tracked');
              onTracked();
            })
            .catch((err) => {
              setError(String((err as Error)?.message ?? err));
              setState('error');
            });
        }}
      />
      {error ? <span className="ai-trade-track-error">{error}</span> : null}
    </span>
  );
}

/**
 * End-of-turn trade list from suggest_trades — no freeform markdown parsing.
 */
export function SuggestedTradesView({
  trades,
  chatId,
  enableTrack = true,
}: {
  trades: SuggestedTrades;
  /** Live chat id — used to dedupe tracked suggestions. */
  chatId?: string | null;
  /** When false (e.g. admin directory), hide Track actions. */
  enableTrack?: boolean;
}) {
  const { data: session } = authClient.useSession();
  const signedIn = Boolean(session?.user);
  const [chatPositions, setChatPositions] = useState<
    Array<{ chat_id: string | null; ticker: string; structure: string }>
  >([]);
  const hasTrades = trades.trades.length > 0;

  useEffect(() => {
    if (!enableTrack || !signedIn || !chatId || !hasTrades) {
      setChatPositions([]);
      return;
    }
    let cancelled = false;
    void api.portfolio({ status: 'open', refresh: false })
      .then((book) => {
        if (cancelled) return;
        setChatPositions(
          book.positions
            .filter((p) => p.chat_id === chatId)
            .map((p) => ({ chat_id: p.chat_id, ticker: p.ticker, structure: p.structure })),
        );
      })
      .catch(() => {
        if (!cancelled) setChatPositions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enableTrack, signedIn, chatId, hasTrades, trades.trades.length]);

  return (
    <section className="ai-trades" aria-label="Suggested trades">
      <header className="ai-trades-head">
        <span className="ai-trades-kicker">Suggested trades</span>
        <span className="ai-trades-note">
          {hasTrades ? `${trades.trades.length} idea${trades.trades.length === 1 ? '' : 's'}` : 'No lean'}
          {signedIn && hasTrades ? ' · paper book' : ''}
        </span>
      </header>
      {!hasTrades && trades.skip_reason ? (
        <p className="ai-trades-skip">{trades.skip_reason}</p>
      ) : null}
      {hasTrades ? (
        <ul className="ai-trades-list">
          {trades.trades.map((trade, index) => (
            <li key={`${trade.ticker}-${trade.structure}-${index}`} className="ai-trade-row">
              <div className="ai-trade-meta">
                <span className="ai-trade-ticker">{trade.ticker}</span>
                <span className={`ai-trade-bias ai-trade-bias-${trade.bias}`}>{biasLabel(trade.bias)}</span>
                <span className="ai-trade-conviction">{trade.conviction}</span>
                {enableTrack ? (
                  <TrackTradeButton
                    trade={trade}
                    tradeIndex={index}
                    chatId={chatId}
                    alreadyTracked={matchesChatPosition(trade, chatId, chatPositions)}
                    onTracked={() => {
                      setChatPositions((prev) => [
                        ...prev,
                        { chat_id: chatId ?? null, ticker: trade.ticker, structure: trade.structure },
                      ]);
                    }}
                  />
                ) : null}
              </div>
              <div className="ai-trade-structure">{trade.structure}</div>
              {trade.legs?.length ? (
                <div className="ai-trade-legs">
                  {trade.legs.map((leg, legIndex) => (
                    <span key={legIndex} className="ai-trade-leg">{formatTradeLeg(leg)}</span>
                  ))}
                </div>
              ) : null}
              <p className="ai-trade-rationale">{trade.rationale}</p>
              {trade.liquidity ? <p className="ai-trade-liquidity">{trade.liquidity}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function isSuggestedTrades(value: unknown): value is SuggestedTrades {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.trades)) return false;
  if (rec.trades.length === 0) {
    // Empty list is a valid no-lean; skip_reason is optional (worker defaults it).
    return rec.skip_reason === undefined
      || (typeof rec.skip_reason === 'string' && rec.skip_reason.trim().length > 0);
  }
  return rec.trades.every((trade) => {
    if (!trade || typeof trade !== 'object' || Array.isArray(trade)) return false;
    const t = trade as Record<string, unknown>;
    return (
      typeof t.ticker === 'string' && t.ticker.trim().length > 0
      && (t.bias === 'bullish' || t.bias === 'bearish' || t.bias === 'neutral')
      && (t.conviction === 'high' || t.conviction === 'medium' || t.conviction === 'low')
      && typeof t.structure === 'string' && t.structure.trim().length > 0
      && typeof t.rationale === 'string' && t.rationale.trim().length > 0
    );
  });
}
