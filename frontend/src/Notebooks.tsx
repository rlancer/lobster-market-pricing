import { useCallback, useEffect, useMemo, useState } from 'react';
import { Tooltip } from '@astryxdesign/core';
import './Notebooks.css';
import { api, type PremiumNotebook, type PremiumNotebookRow } from './api';

type NotebookId = 'premium-45d';

const NOTEBOOKS: { id: NotebookId; name: string; description: string }[] = [
  {
    id: 'premium-45d',
    name: '45 DTE premium scan',
    description:
      'For each S&P 500 name, the expiration closest to 45 DTE is selected. ' +
      'Within a ±moneyness band of spot, the single call and single put with ' +
      'the highest option price as a proportion of the underlying spot ' +
      '(premium richness) are ranked. Puts and calls are shown independently.',
  },
];

const fmtNum = (v: number | null | undefined, d = 2): string => {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtInt = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : v.toLocaleString();
const fmtPct = (v: number | null | undefined, d = 1): string => {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
};
const fmtRatio = (v: number | null | undefined, d = 1): string => {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return `${(v * 100).toFixed(d)}%`;
};
const fmtDate = (s: string): string => {
  if (!s) return '–';
  return new Date(s).toISOString().slice(0, 10);
};

interface SortState {
  key: keyof PremiumNotebookRow;
  dir: 'asc' | 'desc';
}

function PremiumTable({
  title,
  rows,
  kind,
  onPickSymbol,
}: {
  title: string;
  rows: PremiumNotebookRow[];
  kind: 'call' | 'put';
  onPickSymbol: (s: string) => void;
}) {
  const [sort, setSort] = useState<SortState>({ key: 'premium_ratio', dir: 'desc' });

  const sorted = useMemo(() => {
    const arr = [...rows];
    const { key, dir } = sort;
    arr.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === 'number' && typeof bv === 'number') {
        return dir === 'asc' ? av - bv : bv - av;
      }
      const as = av === null || av === undefined ? '' : String(av);
      const bs = bv === null || bv === undefined ? '' : String(bv);
      return dir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return arr;
  }, [rows, sort]);

  const handleSort = (key: keyof PremiumNotebookRow) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  const columns: { key: keyof PremiumNotebookRow; label: string; align?: 'right' | 'left' }[] = [
    { key: 'symbol', label: 'Symbol' },
    { key: 'name', label: 'Name' },
    { key: 'spot', label: 'Spot', align: 'right' },
    { key: 'expiration', label: 'Expiry' },
    { key: 'strike', label: 'Strike', align: 'right' },
    { key: 'premium', label: 'Premium', align: 'right' },
    { key: 'premium_ratio', label: 'Prem / Spot', align: 'right' },
    { key: 'moneyness', label: 'Moneyness', align: 'right' },
    { key: 'implied_vol', label: 'IV', align: 'right' },
    { key: 'delta', label: 'Δ', align: 'right' },
    { key: 'volume', label: 'Vol', align: 'right' },
    { key: 'open_interest', label: 'OI', align: 'right' },
  ];

  const arrow = (k: keyof PremiumNotebookRow) =>
    sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div className={`nb-table nb-${kind}`}>
      <div className="nb-table-head">
        <span className={`badge ${kind}`}>{kind.toUpperCase()}S</span>
        <h3>{title}</h3>
        <span className="nb-count">{sorted.length} names</span>
      </div>
      <div className="table-wrap">
        <table className="screener">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.align === 'right' ? 'right' : 'left'}>
                  <button className="sort-btn" onClick={() => handleSort(c.key)}>
                    {c.label}{arrow(c.key)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={`${r.symbol}-${i}`} className={kind === 'call' ? 'row-call' : 'row-put'}
                  onClick={() => onPickSymbol(r.symbol)}>
                <td><Tooltip content={`Click to explore ${r.symbol} option chain`} hasHoverIndication={false}><b>{r.symbol}</b></Tooltip></td>
                <td className="muted">{r.name ?? '–'}</td>
                <td className="right">{fmtNum(r.spot)}</td>
                <td>{fmtDate(r.expiration)}</td>
                <td className="right">{fmtNum(r.strike, 0)}</td>
                <td className="right">{fmtNum(r.premium)}</td>
                <td className="right ratio">{fmtRatio(r.premium_ratio)}</td>
                <td className="right moneyness">{fmtPct(r.moneyness)}</td>
                <td className="right">{fmtNum(r.implied_vol, 3)}</td>
                <td className="right">{fmtNum(r.delta, 3)}</td>
                <td className="right">{fmtInt(r.volume)}</td>
                <td className="right">{fmtInt(r.open_interest)}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={columns.length} className="empty">No {kind}s match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface NotebooksProps {
  onPickSymbol: (s: string) => void;
  liquidOnly: boolean;
}

function Notebooks({ onPickSymbol, liquidOnly }: NotebooksProps) {
  const [active, setActive] = useState<NotebookId>('premium-45d');
  const [data, setData] = useState<PremiumNotebook | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // notebook parameters
  const [targetDte, setTargetDte] = useState(45);
  const [tolerance, setTolerance] = useState(7);
  const [band, setBand] = useState(15); // %
  const [minVolume, setMinVolume] = useState(0);
  const [limit, setLimit] = useState(25);

  const run = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const d = await api.notebookPremium({
        target_dte: targetDte,
        tolerance,
        moneyness_band: band / 100,
        min_volume: minVolume,
        liquid_only: liquidOnly,
        limit,
      });
      setData(d);
    } catch (e) {
      setError(String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [targetDte, tolerance, band, minVolume, liquidOnly, limit]);

  useEffect(() => { const t = setTimeout(run, 250); return () => clearTimeout(t); }, [run]);

  const meta = NOTEBOOKS.find((n) => n.id === active)!;

  return (
    <div className="notebooks">
      <aside className="nb-sidebar">
        <h2>Research</h2>
        <p className="muted">Repeatable, parameterized studies.</p>
        <ul className="nb-list">
          {NOTEBOOKS.map((n) => (
            <li key={n.id}>
              <button className={`nb-item ${active === n.id ? 'active' : ''}`} onClick={() => setActive(n.id)}>
                <span className="nb-item-name">{n.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="nb-main">
        <div className="nb-desc">
          <h2>{meta.name}</h2>
          <p className="muted">{meta.description}</p>
        </div>

        <div className="nb-params">
          <label>Target DTE
            <input type="number" value={targetDte} onChange={(e) => setTargetDte(Number(e.target.value))} />
          </label>
          <label>DTE tolerance (±)
            <input type="number" value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
          </label>
          <label>Distance from spot %
            <input type="number" value={band} onChange={(e) => setBand(Number(e.target.value))} />
          </label>
          <label>Min volume
            <input type="number" value={minVolume} onChange={(e) => setMinVolume(Number(e.target.value))} />
          </label>
          <label>Results per side
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div className="actions">
            <button onClick={run} disabled={loading}>{loading ? 'Running study…' : 'Refresh study'}</button>
          </div>
        </div>

        {error && <div className="error">Error: {error}</div>}

        {data && (
          <div className="nb-meta">
            Showing contracts expiring closest to <b>{data.target_dte}</b> DTE
            (±{data.tolerance}), within <b>{(data.moneyness_band * 100).toFixed(0)}%</b> of spot,
            ranked by premium / spot ratio.
          </div>
        )}

        <div className="nb-grid">
          {data && (
            <>
              <PremiumTable title="Call premium leaders" rows={data.calls} kind="call" onPickSymbol={onPickSymbol} />
              <PremiumTable title="Put premium leaders" rows={data.puts} kind="put" onPickSymbol={onPickSymbol} />
            </>
          )}
          {!data && !error && <div className="empty">Loading…</div>}
        </div>
      </section>
    </div>
  );
}

export default Notebooks;
