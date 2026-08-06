import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import './App.css';
import Explorer from './Explorer';
import AiChat from './AiChat';
import LiquidityFilter from './LiquidityFilter';
import RefreshRuns from './RefreshRuns';
import LoaderStatus from './LoaderStatus';
import Notebooks from './Notebooks';
import SymbolDetail from './SymbolDetail';
import SymbolTypeahead from './SymbolTypeahead';
import { api, useDbReady, type OptionRow, type SectorRow, type Stats } from './api';
import { handleOAuthCallback, isOAuthCallback } from './ai';

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

function App() {
  const db = useDbReady();
  const [view, setView] = useState<'screener' | 'explorer' | 'notebooks' | 'ai' | 'loader'>('screener');
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [sectors, setSectors] = useState<SectorRow[]>([]);
  const [rows, setRows] = useState<OptionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // filters
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
  const [liquidOnly, setLiquidOnly] = useState(true); // global liquidity gate
  const [nearSpot, setNearSpot] = useState('50'); // strikes around spot
  const [sort, setSort] = useState<SortKey>('volume');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [limit, setLimit] = useState(100);

  const loadStats = useCallback(async () => {
    try {
      const [s, sec] = await Promise.all([api.stats(liquidOnly), api.sectors(liquidOnly)]);
      setStats(s); setSectors(sec);
    } catch (e) {
      setError(String(e));
    }
  }, [liquidOnly]);

  const runScreen = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // moneyness filter: only include contracts within maxMoneyness% of spot
      // (implemented server-side via strike range when spot known is complex;
      //  we approximate client-side after fetch when maxMoneyness set)
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

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { const t = setTimeout(runScreen, 250); return () => clearTimeout(t); }, [runScreen]);

  // ----- OpenRouter OAuth callback ----------------------------------------
  // If the page loaded via ?oauth_callback=1&code=…, exchange the code for an
  // API key before rendering the rest of the app.
  useEffect(() => {
    if (!isOAuthCallback()) return;
    handleOAuthCallback()
      .then(() => {
        // Landing on Copilot with the key set is the most useful default.
        setView('ai');
      })
      .catch((e) => console.error('[ai] OAuth callback failed:', e));
  }, []);

  // ----- URL route sync -----------------------------------------------------
  // The current view is encoded in the query string so any state is shareable:
  //   ?symbol=NVDA  -> open NVIDIA's option-chain detail page
  //   ?tab=explorer -> open the Data Explorer
  // On first mount, restore state from the URL (so a shared route loads right).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const sym = sp.get('symbol');
    const tab = sp.get('tab');
    if (tab === 'explorer') setView('explorer');
    else if (tab === 'notebooks') setView('notebooks');
    else if (tab === 'ai') setView('ai');
    else if (tab === 'loader') setView('loader');
    else if (tab === 'screener') setView('screener');
    if (sym && sym.trim()) setSelectedSymbol(sym.trim().toUpperCase());
  }, []); // run once

  // Reflect current view/symbol into the URL. Opening a symbol pushes a new
  // history entry (so the browser Back button closes the detail page); other
  // transitions (tab switch, closing a symbol) just replace the current entry.
  const prevRouteSym = useRef<string | null>(selectedSymbol);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (selectedSymbol) sp.set('symbol', selectedSymbol); else sp.delete('symbol');
    if (view === 'explorer') sp.set('tab', 'explorer');
    else if (view === 'notebooks') sp.set('tab', 'notebooks');
    else if (view === 'ai') sp.set('tab', 'ai');
    else if (view === 'loader') sp.set('tab', 'loader');
    else sp.delete('tab');
    const qs = sp.toString();
    const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    const openedSymbol = !!selectedSymbol && !prevRouteSym.current;
    if (openedSymbol) window.history.pushState(null, '', next);
    else window.history.replaceState(null, '', next);
    prevRouteSym.current = selectedSymbol;
  }, [selectedSymbol, view]);

  // Respond to browser back/forward (popstate) by restoring state from the URL.
  useEffect(() => {
    const onPop = () => {
      const sp = new URLSearchParams(window.location.search);
      const sym = sp.get('symbol');
      const tab = sp.get('tab');
      setView(tab === 'explorer' ? 'explorer' : tab === 'notebooks' ? 'notebooks' : tab === 'ai' ? 'ai' : tab === 'loader' ? 'loader' : 'screener');
      setSelectedSymbol(sym && sym.trim() ? sym.trim().toUpperCase() : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

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
  const updatedAt = stats?.last_updated
    ? new Date(stats.last_updated.replace(' ', 'T')).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : '–';

  if (!db.ready) {
    return (
      <div className="app">
        <div className="db-loading">
          <span className="loading-mark" aria-hidden="true" />
          <b>{db.error ? 'Dataset unavailable' : 'Opening market data'}</b>
          <span>{db.error ? db.error : 'Connecting to the screener API…'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">🦞</span>
          <span>
            <h1>Lobster MP</h1>
            <small>S&amp;P 500 options screener</small>
          </span>
        </div>
        <div className="header-tools">
          <LiquidityFilter checked={liquidOnly} onChange={setLiquidOnly} />
          <span className="data-status"><StatusDot variant="success" label="Dataset ready" /> Dataset ready</span>
          <span className="updated">As of {updatedAt}</span>
          <RefreshRuns />
        </div>
      </header>

      <nav className="tabs" aria-label="Workspace">
        <button className={`tab ${view === 'screener' ? 'active' : ''}`} onClick={() => setView('screener')}>Market</button>
        <button className={`tab ${view === 'notebooks' ? 'active' : ''}`} onClick={() => setView('notebooks')}>Research</button>
        <button className={`tab ${view === 'explorer' ? 'active' : ''}`} onClick={() => setView('explorer')}>SQL Lab</button>
        <button className={`tab ${view === 'ai' ? 'active' : ''}`} onClick={() => setView('ai')}>Copilot</button>
        <button className={`tab ${view === 'loader' ? 'active' : ''}`} onClick={() => setView('loader')}>Monitor</button>
        <div className="stats" aria-label="Dataset summary">
          <span><b>{stats?.underlyings ?? '–'}</b> symbols</span>
          <span><b>{stats?.contracts?.toLocaleString() ?? '–'}</b> contracts</span>
          <span><b>{stats?.calls?.toLocaleString() ?? '–'}</b> calls</span>
          <span><b>{stats?.puts?.toLocaleString() ?? '–'}</b> puts</span>
        </div>
      </nav>

      {view === 'explorer' ? <Explorer /> : view === 'loader' ? <LoaderStatus /> : view === 'ai' ? <AiChat /> : view === 'notebooks' ? (
        selectedSymbol ? (
          <SymbolDetail symbol={selectedSymbol} onBack={() => setSelectedSymbol(null)} />
        ) : (
          <Notebooks onPickSymbol={(s) => setSelectedSymbol(s)} liquidOnly={liquidOnly} />
        )
      ) : (
        selectedSymbol ? (
          <SymbolDetail symbol={selectedSymbol} onBack={() => setSelectedSymbol(null)} />
        ) : (
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
                  onClick={() => setSelectedSymbol(r.symbol)}
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
        )
      )}

      <footer className="app-footer">
        <span>Market data for research only. Quotes may be delayed.</span>
        <span>CBOE · Cloudflare Worker · R2 SQL · Iceberg lake</span>
      </footer>
    </div>
  );
}

export default App;
