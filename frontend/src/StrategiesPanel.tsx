import { useMemo, useState } from 'react';
import './StrategiesPanel.css';
import {
  STRATEGY_BUILDERS,
  positionPayoff,
  type PricingResult,
} from './strategies';
import type { ChainContract } from './api';

const CONTRACT = 100;

const fmtNum = (v: number | null | undefined, d = 2): string => {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  const s = v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  return v < 0 ? `-${s.replace('-', '')}` : s;
};
const fmtMoney = (v: number | null | undefined): string => {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return `$${fmtNum(v, 0)}`;
};

interface Props {
  /** contracts for ONE expiration (the panel uses the currently-selected one) */
  contracts: ChainContract[];
  spot: number | null;
  expiration: string | null;
  /** compact mode for embedding (e.g. symbol page) */
  compact?: boolean;
  initialQty?: number;
}

const CATEGORY_ORDER: PricingResult['category'][] = [
  'Single-Leg', 'Vertical Spread', 'Straddle/Strangle', 'Iron', 'Stock-Covered',
];
const CATEGORY_LABEL: Record<string, string> = {
  'Single-Leg': 'Single-Leg',
  'Vertical Spread': 'Vertical Spreads',
  'Straddle/Strangle': 'Straddles & Strangles',
  Iron: 'Iron Structures',
  'Stock-Covered': 'Stock-Covered',
};
const BIAS_LABEL: Record<string, string> = {
  bullish: 'bullish', bearish: 'bearish', neutral: 'neutral',
  volatile: 'volatility', 'capital-preserving': 'capital-preserving',
};

/** Build all strategies for the supplied chain, grouped by category. */
function buildAll(contracts: ChainContract[], spot: number, qty: number) {
  const strikes = Array.from(new Set(contracts.map((c) => c.strike))).sort((a, b) => a - b);
  const results: PricingResult[] = [];
  for (const b of STRATEGY_BUILDERS) {
    try {
      const r = b.build(contracts, spot, strikes, qty);
      if (r) results.push(r);
    } catch {
      /* skip if chain can't support it */
    }
  }
  // group by category in a stable order
  const groups: Record<string, PricingResult[]> = {};
  for (const cat of CATEGORY_ORDER) groups[cat] = [];
  for (const r of results) (groups[r.category] ??= []).push(r);
  return groups;
}

/** SVG payoff-at-expiration diagram for one strategy. */
function PayoffChart({ result, spot }: { result: PricingResult; spot: number }) {
  const W = 240, H = 96, P = { l: 6, r: 6, t: 10, b: 14 };
  const { legs, breakevens } = result;

  // price range: cover all leg strikes and ±30% of spot
  const allK = legs.map((l) => l.strike).filter((x): x is number => x != null && x > 0);
  const lo = Math.min(spot * 0.6, ...(allK.length ? allK : [spot * 0.6]));
  const hi = Math.max(spot * 1.4, ...(allK.length ? allK : [spot * 1.4]), spot * 1.4);
  const steps = 120;
  const xs: number[] = [];
  const ys: number[] = [];
  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i <= steps; i++) {
    const s = lo + (hi - lo) * (i / steps);
    const p = positionPayoff(legs, s, result.legs[0]?.qty ?? 1);
    xs.push(s);
    ys.push(p);
    if (p < yMin) yMin = p;
    if (p > yMax) yMax = p;
  }
  // clamp unbounded: if max profit is null (unlimited), cap the visible y at
  // a sensible multiple of the net premium so the curve stays readable.
  const cap = Math.max(Math.abs(result.netPremiumTotal), spot * CONTRACT * 0.1, 50);
  if (result.maxProfit === null) yMax = Math.min(yMax, cap);
  if (result.maxLoss === null) yMin = Math.max(yMin, -cap);
  // ensure some padding around zero
  yMin = Math.min(yMin, -Math.abs(yMax) * 0.05);
  yMax = Math.max(yMax, Math.abs(yMin) * 0.05, 1);

  const x = (s: number) => P.l + ((s - lo) / (hi - lo)) * (W - P.l - P.r);
  const y = (v: number) => {
    const t = (v - yMin) / (yMax - yMin);
    return H - P.b - t * (H - P.t - P.b);
  };
  const path = xs.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s).toFixed(1)},${y(ys[i]).toFixed(1)}`).join(' ');
  const yZero = y(0);
  const xSpot = x(spot);

  // profit/loss color
  const stroke = result.maxProfit !== null && result.maxLoss === null
    ? 'var(--call)'
    : result.maxLoss !== null && result.maxProfit === null
      ? 'var(--put)'
      : 'var(--accent)';

  return (
    <svg className="payoff-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      {/* zero baseline */}
      <line x1={P.l} y1={yZero} x2={W - P.r} y2={yZero} className="po-axis" />
      {/* spot marker */}
      <line x1={xSpot} y1={P.t} x2={xSpot} y2={H - P.b} className="po-spot" />
      {/* breakevens */}
      {breakevens.slice(0, 3).map((b, i) => (
        <circle key={i} cx={x(b)} cy={yZero} r={2.5} className="po-bep" />
      ))}
      {/* payoff curve */}
      <path d={path} className="po-curve" style={{ stroke }} />
    </svg>
  );
}

function StrategyCard({ result, spot, open, onToggle }: {
  result: PricingResult;
  spot: number;
  open: boolean;
  onToggle: () => void;
}) {
  const profit = result.maxProfit;
  const loss = result.maxLoss;
  const credit = result.netCreditPerShare * CONTRACT * (result.legs[0]?.qty ?? 1);

  return (
    <div className={`strategy-card ${result.definedRisk ? 'defined' : 'undefined'}`}>
      <button className="strat-head" onClick={onToggle}>
        <span className="strat-name">{result.name}</span>
        <span className={`strat-bias bias-${result.bias}`}>{BIAS_LABEL[result.bias]}</span>
        <span className={`strat-risk ${result.definedRisk ? 'def' : 'undef'}`}>
          {result.definedRisk ? 'defined risk' : 'undefined risk'}
        </span>
        <span className="strat-chev">{open ? '▾' : '▸'}</span>
      </button>

      <div className="strat-quick">
        <span className="qp">
          <label>net</label>
          <b className={credit >= 0 ? 'pos' : 'neg'}>
            {credit >= 0 ? 'credit ' : 'debit '}{fmtMoney(Math.abs(credit))}
          </b>
        </span>
        <span className="qp">
          <label>buying power</label>
          <b>{fmtMoney(result.buyingPower)}</b>
        </span>
        <span className="qp">
          <label>max profit</label>
          <b className={profit === null ? 'unbounded' : 'pos'}>
            {profit === null ? '∞' : fmtMoney(profit)}
          </b>
        </span>
        <span className="qp">
          <label>max loss</label>
          <b className={loss === null ? 'unbounded' : 'neg'}>
            {loss === null ? '∞' : fmtMoney(loss)}
          </b>
        </span>
        <span className="qp">
          <label>breakeven{result.breakevens.length === 1 ? '' : 's'}</label>
          <b>
            {result.breakevens.length
              ? result.breakevens.map((b) => fmtNum(b, 0)).join(', ')
              : '–'}
          </b>
        </span>
      </div>

      {open && (
        <div className="strat-detail">
          <div className="strat-cols">
            <div className="strat-block">
              <h4>Payoff at expiration</h4>
              <PayoffChart result={result} spot={spot} />
              <div className="chart-legend">
                <span className="lg-spot" /> stock
                <span className="lg-bep" /> breakeven
                <span className="lg-zero" /> break-even line
              </div>
              <p className="blurb">{result.payoffBlurb}</p>
            </div>
            <div className="strat-block">
              <h4>Legs</h4>
              <table className="legs-tbl">
                <thead>
                  <tr><th>side</th><th>type</th><th className="r">strike</th><th className="r">price</th><th className="r">qty</th></tr>
                </thead>
                <tbody>
                  {result.legs.map((l, i) => (
                    <tr key={i}>
                      <td className={l.side === 'long' ? 'long' : 'short'}>{l.side}</td>
                      <td>{l.kind === 'stock' ? 'stock' : l.optType}</td>
                      <td className="r">{l.strike != null ? fmtNum(l.strike, 0) : `@${fmtNum(l.price, 2)}`}</td>
                      <td className="r">{fmtNum(l.price, 2)}</td>
                      <td className="r">{l.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="margin-note">
            <h4>How the buying power is estimated</h4>
            <p>{result.marginMethod}</p>
            <p className="margin-disclaimer">
              Figures use simplified Reg-T rules, mid-priced fills where the quote is missing,
              and assume 100-share contracts. Real broker margin depends on your account type
              (cash / Reg-T / portfolio margin), concentration, and intraday moves — always
              confirm in your broker&rsquo;s calculator before placing the trade.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Reusable panel: prices common strategies off one expiration's chain. */
export default function StrategiesPanel({
  contracts, spot, expiration, compact = false, initialQty = 1,
}: Props) {
  const [qty, setQty] = useState(initialQty);
  const [openName, setOpenName] = useState<string | null>(null);

  const groups = useMemo(() => {
    if (!spot || spot <= 0 || contracts.length === 0) return null;
    return buildAll(contracts, spot, qty);
  }, [contracts, spot, qty]);

  const hasData = !!groups && Object.values(groups).some((g) => g.length > 0);

  return (
    <div className={`strategies-panel ${compact ? 'compact' : ''}`}>
      <div className="sp-header">
        <div className="sp-title">
          <h3>Strategy Pricing</h3>
          <span className="muted small">
            {expiration ? `priced on ${expiration}` : 'pick an expiration'}
            {spot ? ` · spot ${fmtNum(spot, 2)}` : ''}
          </span>
        </div>
        <label className="qty-pick">
          contracts
          <input
            type="number"
            min={1}
            max={100}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
          />
        </label>
      </div>

      {!hasData && (
        <div className="empty">No strikes available for the selected expiration.</div>
      )}

      {hasData && groups && (
        <div className="sp-groups">
          {CATEGORY_ORDER.map((cat) => {
            const items = groups[cat] ?? [];
            if (!items.length) return null;
            return (
              <section key={cat} className="sp-group">
                <h4 className="sp-cat">{CATEGORY_LABEL[cat]}</h4>
                <div className="sp-cards">
                  {items.map((r) => (
                    <StrategyCard
                      key={r.name}
                      result={r}
                      spot={spot ?? 0}
                      open={openName === r.name}
                      onToggle={() => setOpenName((n) => (n === r.name ? null : r.name))}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <div className="sp-footer">
        <span className="muted small">
          P/L and buying power are theoretical at-expiration estimates from the chain&rsquo;s
          bid/ask. Net shown as credit (received) or debit (paid).
        </span>
      </div>
    </div>
  );
}
