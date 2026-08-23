/**
 * Structured suggested trades — shared by live chat, share, and timeline.
 * Dense rows (not cards): bias/conviction tokens + structure + optional legs.
 *
 * Legs are formal: instrument option|equity|kalshi, side buy/sell
 * (long/short), optional qty. Worker normalize always sets instrument;
 * optional here so legacy share payloads still typecheck.
 */

export type TradeBias = 'bullish' | 'bearish' | 'neutral';
export type TradeConviction = 'high' | 'medium' | 'low';
export type OptionRight = 'call' | 'put';
export type TradeSide = 'buy' | 'sell';
export type KalshiContractSide = 'yes' | 'no';
export type LegInstrument = 'option' | 'equity' | 'kalshi';

/**
 * Flat leg shape for UI + API wire.
 * Prefer instrument + (for options) right + strike|strike_rel;
 * for Kalshi, market_ticker + optional contract_side.
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
  market_ticker?: string;
  contract_side?: KalshiContractSide;
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
  if (leg.instrument === 'option' || leg.instrument === 'equity' || leg.instrument === 'kalshi') {
    return leg.instrument;
  }
  if (leg.market_ticker) return 'kalshi';
  if (leg.right || leg.strike != null || leg.strike_rel) return 'option';
  return 'equity';
}

export function formatTradeLeg(leg: TradeLeg): string {
  const qty = leg.qty != null ? `${leg.qty} ` : '';
  const sym = leg.symbol ? ` ${leg.symbol}` : '';
  const kind = resolveInstrument(leg);
  if (kind === 'equity') {
    return `${leg.side} ${qty}shares${sym}`.replace(/\s+/g, ' ').trim();
  }
  if (kind === 'kalshi') {
    const side = (leg.contract_side ?? 'yes').toUpperCase();
    const ticker = leg.market_ticker ?? '?';
    return `${leg.side} ${qty}${side} ${ticker}${sym}`.replace(/\s+/g, ' ').trim();
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

/**
 * End-of-turn trade list from suggest_trades — no freeform markdown parsing.
 */
export function SuggestedTradesView({ trades }: { trades: SuggestedTrades }) {
  const hasTrades = trades.trades.length > 0;
  return (
    <section className="ai-trades" aria-label="Suggested trades">
      <header className="ai-trades-head">
        <span className="ai-trades-kicker">Suggested trades</span>
        <span className="ai-trades-note">
          {hasTrades ? `${trades.trades.length} idea${trades.trades.length === 1 ? '' : 's'}` : 'No lean'}
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
