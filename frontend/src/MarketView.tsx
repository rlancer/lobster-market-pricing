import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@astryxdesign/core/Button';
import SymbolTypeahead from './SymbolTypeahead';
import { api, type OptionRow } from './api';
import { useWorkspace } from './workspace';

type SortKey =
  | 'volume' | 'open_interest' | 'strike' | 'implied_vol' | 'delta'
  | 'theta' | 'vega' | 'gamma' | 'bid' | 'ask' | 'last' | 'expiration' | 'moneyness_pct';

const fmtNum = (v: number | null | undefined, d = 2): string => {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtInt = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : v.toLocaleString();

const fmtPct = (v: number | null | undefined): string => {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
};

const fmtDate = (s: string): string => {
  if (!s) return '–';
  const d = new Date(s);
  return d.toISOString().slice(0, 10);
};

const columns: { key: SortKey | 'type' | 'symbol' | 'name'; label: string; align?: 'right' | 'left' }[] = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'expiration', label: 'Expiration' },
  { key: 'strike', label: 'Strike', align: 'right' },
  { key: 'moneyness_pct', label: 'Moneyness', align: 'right' },
  { key: 'last', label: 'Last', align: 'right' },
  { key: 'bid', label: 'Bid', align: 'right' },
  { key: 'ask', label: 'Ask', align: 'right' },
  { key: 'volume', label: 'Vol', align: 'right' },
  { key: 'open_interest', label: 'OI', align: 'right' },
  { key: 'implied_vol', label: 'IV', align: 'right' },
  { key: 'delta', label: 'Δ', align: 'right' },
  { key: 'gamma', label: 'Γ', align: 'right' },
  { key: 'theta', label: 'Θ', align: 'right' },
  { key: 'vega', label: 'ν', align: 'right' },
];

export default function MarketView() {
  const { liquidOnly, setLiquidOnly, sectors } = useWorkspace();
  const navigate = useNavigate();

  const [symbol, setSymbol] = useState('');
  const [type, setType] = useState<'' | 'call' | 'put'>('');
  const [sector, setSector] = useState('');
  const [minVolume, setMinVolume] = useState('');
  const [minOI, setMinOI] = useState('');
  const [minIV, setMinIV] = useState('');
  const [maxIV, setMaxIV] = useState('');
  const [minDelta, setMinDelta] = useState('');
  const [maxDelta, setMaxDelta] = useState('');
  const [maxMoneyness, setMaxMoneyness] = useState(''); // % OTM cap
  const [nearSpot, setNearSpot] = useState('50'); // strikes around spot
  const [sort, setSort] = useState<SortKey>('volume');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [limit, setLimit] = useState(100);
  const [rows, setRows] = useState<OptionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runScreen = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.screen({
        symbol: symbol.toUpperCase() || undefined,
        type: type || undefined,
        sector: sector || undefined,
        min_volume: minVolume ? Number(minVolume) : undefined,
        min_open_interest: minOI ? Number(minOI) : undefined,
        min_iv: minIV ? Number(minIV) : undefined,
        max_iv: maxIV ? Number(maxIV) : undefined,
        min_delta: minDelta ? Number(minDelta) : undefined,
        max_delta: maxDelta ? Number(maxDelta) : undefined,
        near_spot_strikes: nearSpot !== '' ? Number(nearSpot) : undefined,
        liquid_only: liquidOnly,
        sort, order, limit,
      });
      // moneyness filter: approximate client-side after fetch (implemented
      // server-side is complex when spot is unknown).
      let items = res.items;
      if (maxMoneyness !== '') {
        const cap = Math.abs(Number(maxMoneyness));
        items = items.filter(
          (r) => r.moneyness_pct !== null && Math.abs(r.moneyness_pct) <= cap
        );
      }
      setRows(items);
      setTotal(res.total);
    } catch (e) {
      setError(String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [symbol, type, sector, minVolume, minOI, minIV, maxIV, minDelta, maxDelta,
      maxMoneyness, liquidOnly, nearSpot, sort, order, limit]);

  useEffect(() => { const t = setTimeout(runScreen, 250); return () => clearTimeout(t); }, [runScreen]);

  const handleSort = (key: SortKey) => {
    if (sort === key) setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setOrder('desc'); }
  };

  const reset = () => {
    setSymbol(''); setType(''); setSector(''); setMinVolume(''); setMinOI('');
    setMinIV(''); setMaxIV(''); setMinDelta(''); setMaxDelta(''); setMaxMoneyness('');
    setLiquidOnly(true);
    setNearSpot('50');
    setSort('volume'); setOrder('desc'); setLimit(100);
  };

  const sectorList = useMemo(() => sectors.map((s) => s.sector).sort(), [sectors]);
  const activeFilterCount = [symbol, type, sector, minVolume, minOI, minIV, maxIV,
    minDelta, maxDelta, maxMoneyness].filter(Boolean).length + (!liquidOnly ? 1 : 0);

  return (
    <>
      <section className="filters">
        <div className="filter-heading">
          <div>
            <h2>Contract finder</h2>
            <p>Narrow the chain. Results refresh as you work.</p>
          </div>
          <span className={`filter-count ${activeFilterCount ? 'active' : ''}`}>
            {activeFilterCount ? `${activeFilterCount} filters applied` : 'No custom filters'}
          </span>
        </div>
        <div className="filter-row">
          <label>Underlying
            <SymbolTypeahead
              value={symbol}
              onChange={setSymbol}
              onSelect={(s) => setSymbol(s)}
              liquidOnly={liquidOnly}
            />
          </label>
          <label>Contract
            <select value={type} onChange={(e) => setType(e.target.value as '' | 'call' | 'put')}>
              <option value="">All</option>
              <option value="call">Calls</option>
              <option value="put">Puts</option>
            </select>
          </label>
          <label>Sector
            <select value={sector} onChange={(e) => setSector(e.target.value)}>
              <option value="">All</option>
              {sectorList.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>Min volume
            <input type="number" value={minVolume} onChange={(e) => setMinVolume(e.target.value)} placeholder="0" />
          </label>
          <label>Min open interest
            <input type="number" value={minOI} onChange={(e) => setMinOI(e.target.value)} placeholder="0" />
          </label>
          <label>IV floor
            <input type="number" step="0.05" value={minIV} onChange={(e) => setMinIV(e.target.value)} placeholder="0.2" />
          </label>
          <label>IV ceiling
            <input type="number" step="0.05" value={maxIV} onChange={(e) => setMaxIV(e.target.value)} placeholder="1.0" />
          </label>
        </div>
        <div className="filter-row">
          <label>Delta floor
            <input type="number" step="0.05" value={minDelta} onChange={(e) => setMinDelta(e.target.value)} placeholder="-1" />
          </label>
          <label>Delta ceiling
            <input type="number" step="0.05" value={maxDelta} onChange={(e) => setMaxDelta(e.target.value)} placeholder="1" />
          </label>
          <label>Distance from spot %
            <input type="number" value={maxMoneyness} onChange={(e) => setMaxMoneyness(e.target.value)} placeholder="15" />
          </label>
          <label>Strike window
            <select value={nearSpot} onChange={(e) => setNearSpot(e.target.value)}>
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="0">All</option>
            </select>
          </label>
          <label>Result size
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <div className="actions">
            <Button label="Refresh results" variant="primary" size="sm" onClick={runScreen} isLoading={loading} />
            <Button label="Clear filters" variant="ghost" size="sm" onClick={reset} />
          </div>
        </div>
      </section>

      {error && <div className="error">Error: {error}</div>}

      <section className="table-wrap">
        <div className="table-meta">
          <span><b>{rows.length.toLocaleString()}</b> shown <span className="meta-separator">/</span> <b>{total.toLocaleString()}</b> matches</span>
          <span>Sorted by <b>{sort.replaceAll('_', ' ')}</b> · {order === 'desc' ? 'high to low' : 'low to high'}</span>
        </div>
        <table className="screener">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.align === 'right' ? 'right' : 'left'}>
                  {(c.key === 'type' || c.key === 'symbol' || c.key === 'name')
                    ? c.label
                    : (
                      <button className="sort-btn" onClick={() => handleSort(c.key as SortKey)}>
                        {c.label}{sort === c.key ? (order === 'asc' ? ' ▲' : ' ▼') : ''}
                      </button>
                    )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.type === 'call' ? 'row-call' : 'row-put'}
                  onClick={() => navigate({ to: '/symbol/$symbol', params: { symbol: r.symbol } })}
                  title={`Click to explore ${r.symbol} option chain`}>
                <td><b>{r.symbol}</b></td>
                <td className="muted">{r.name ?? '–'}</td>
                <td><span className={`badge ${r.type}`}>{r.type}</span></td>
                <td>{fmtDate(r.expiration)}</td>
                <td className="right">{fmtNum(r.strike, 0)}</td>
                <td className="right moneyness">{fmtPct(r.moneyness_pct)}</td>
                <td className="right">{fmtNum(r.last)}</td>
                <td className="right">{fmtNum(r.bid)}</td>
                <td className="right">{fmtNum(r.ask)}</td>
                <td className="right">{fmtInt(r.volume)}</td>
                <td className="right">{fmtInt(r.open_interest)}</td>
                <td className="right">{fmtNum(r.implied_vol, 3)}</td>
                <td className="right">{fmtNum(r.delta, 3)}</td>
                <td className="right">{fmtNum(r.gamma, 4)}</td>
                <td className="right">{fmtNum(r.theta, 3)}</td>
                <td className="right">{fmtNum(r.vega, 3)}</td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={16} className="empty">No contracts match the current filters.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
