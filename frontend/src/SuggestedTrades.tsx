/**
 * Structured suggested trades — shared by live chat, share, and timeline.
 * Dense rows (not cards): bias/conviction tokens + structure + optional legs.
 *
 * Legs are formal: instrument option|equity|kalshi, side buy/sell
 * (long/short), optional qty. Worker normalize always sets instrument;
 * optional here so legacy share payloads still typecheck.
 *
 * For signed-in chat owners, suggest_trades auto-opens paper positions.
 * Track remains for share/timeline viewers (or when auto-mark failed).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@astryxdesign/core';
import { api } from './api';
import { authClient } from './auth';
import { EntityLink } from './EntityLink';
import {
  biasLabel,
  formatTradeLeg,
  resolveInstrument,
  type SuggestedTrade,
  type SuggestedTrades,
  type TradeLeg,
} from './tradeLegFormat';

export type {
  TradeBias,
  TradeConviction,
  OptionRight,
  TradeSide,
  KalshiContractSide,
  LegInstrument,
  TradeLeg,
  SuggestedTrade,
  SuggestedTrades,
} from './tradeLegFormat';
export { formatTradeLeg, resolveInstrument, isSuggestedTrades, biasLabel } from './tradeLegFormat';

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

/** Render a leg with clickable market_ticker / symbol entities. */
export function TradeLegView({ leg }: { leg: TradeLeg }): ReactNode {
  const kind = resolveInstrument(leg);
  const qty = leg.qty != null ? `${leg.qty} ` : '';
  if (kind === 'kalshi') {
    const side = (leg.contract_side ?? 'yes').toUpperCase();
    return (
      <span className="ai-trade-leg">
        {`${leg.side} ${qty}${side} `.replace(/\s+/g, ' ')}
        {leg.market_ticker ? (
          <EntityLink value={leg.market_ticker} className="entity-link" showExternals />
        ) : '?'}
        {leg.symbol ? (
          <>
            {' '}
            <EntityLink value={leg.symbol} className="entity-link" />
          </>
        ) : null}
      </span>
    );
  }
  if (kind === 'equity') {
    return (
      <span className="ai-trade-leg">
        {`${leg.side} ${qty}shares `.replace(/\s+/g, ' ')}
        {leg.symbol ? <EntityLink value={leg.symbol} className="entity-link" /> : null}
      </span>
    );
  }
  const text = formatTradeLeg(leg);
  if (leg.symbol) {
    const idx = text.lastIndexOf(leg.symbol);
    if (idx >= 0) {
      return (
        <span className="ai-trade-leg">
          {text.slice(0, idx)}
          <EntityLink value={leg.symbol} className="entity-link" />
          {text.slice(idx + leg.symbol.length)}
        </span>
      );
    }
  }
  return <span className="ai-trade-leg">{text}</span>;
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
                <EntityLink value={trade.ticker} className="ai-trade-ticker entity-link" showExternals />
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
                    <TradeLegView key={legIndex} leg={leg} />
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
