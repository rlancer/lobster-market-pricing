import { useEffect, useRef, useState } from 'react';
import { api, type LiquidityInfo } from './api';
import './LiquidityFilter.css';

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
}

/** Global "liquid only" toggle for the app header, with an info popover that
 * explains the tradability criteria (fetched from /api/liquidity on first open). */
export default function LiquidityFilter({ checked, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<LiquidityInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Load criteria on first popover open, then keep cached.
  useEffect(() => {
    if (!open || info || loading) return;
    setLoading(true);
    api.liquidity()
      .then((d) => setInfo(d))
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
  }, [open, info, loading]);

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const d = info?.enabled_defaults;

  return (
    <div className="liq-filter" ref={wrapRef}>
      <label className="liq-toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="liq-label">Liquid only</span>
      </label>
      <button
        type="button"
        className="liq-info-btn"
        aria-label="Liquidity criteria"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="What does ‘liquid only’ mean?"
      >
        i
      </button>
      {open && (
        <div className="liq-popover" role="dialog" aria-label="Liquidity criteria">
          <div className="liq-popover-title">
            Tradability filter
            <button className="liq-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          {loading && !info && <div className="liq-popover-body muted">Loading…</div>}
          {info && (
            <>
              <div className="liq-popover-body">
                <p className="liq-desc">{info.description}</p>
                <p className="liq-counts">
                  <b>{info.liquid_underlyings.toLocaleString()}</b> of{' '}
                  <b>{info.total_underlyings.toLocaleString()}</b> underlyings currently qualify.
                </p>
              </div>
              {d && (
                <dl className="liq-criteria">
                  <div><dt>Min near-ATM contracts</dt><dd>≥ {d.min_atm_contracts}</dd></div>
                  <div><dt>ATM band</dt><dd>± {Math.round(d.atm_band * 100)}% of spot</dd></div>
                  <div><dt>Max bid/ask spread</dt><dd>≤ {Math.round(d.max_spread * 100)}% relative</dd></div>
                  <div><dt>Min volume</dt><dd>≥ {d.min_volume}</dd></div>
                  <div><dt>Min open interest</dt><dd>≥ {d.min_open_interest}</dd></div>
                </dl>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
