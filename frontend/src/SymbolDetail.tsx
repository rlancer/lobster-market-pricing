import { useEffect, useMemo, useState } from 'react';
import {
  Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import './SymbolDetail.css';
import { api, type ChainContract, type SymbolDetail as Detail } from './api';
import StrategiesPanel from './StrategiesPanel';

const fmtNum = (v: number | null | undefined, d = 2): string => {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtInt = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : v.toLocaleString();
/** Annualized fraction → percent, e.g. 0.253 → "25.3%". */
const fmtPct = (v: number | null | undefined): string =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : `${(v * 100).toFixed(1)}%`;

interface Props {
  symbol: string;
  onBack: () => void;
}

/** Group contracts for one expiration into per-strike call/put pairs. */
function buildChain(contracts: ChainContract[], expiration: string) {
  const expContracts = contracts.filter((c) => c.expiration === expiration);
  const byStrike = new Map<number, { call?: ChainContract; put?: ChainContract }>();
  for (const c of expContracts) {
    let entry = byStrike.get(c.strike);
    if (!entry) { entry = {}; byStrike.set(c.strike, entry); }
    if (c.type === 'call') entry.call = c;
    else entry.put = c;
  }
  return [...byStrike.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([strike, pair]) => ({ strike, ...pair }));
}

function daysTo(expiration: string): number {
  const d = new Date(expiration);
  const now = new Date();
  return Math.round((d.getTime() - now.getTime()) / 86_400_000);
}

/** Human relative-time label, e.g. "today", "30 DTE", "2.3 yr". */
function dteLabel(days: number): string {
  const abs = Math.abs(days);
  if (abs === 0) return '0 DTE (today)';
  const sign = days < 0 ? '-' : '+';
  if (abs === 1) return `${sign}1 DTE`;
  if (abs < 60) return `${sign}${abs} DTE`;
  if (abs < 365) return `${sign}${(abs / 30.44).toFixed(1)} mo`;
  return `${sign}${(abs / 365.25).toFixed(1)} yr`;
}

function SymbolDetail({ symbol, onBack }: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiration, setExpiration] = useState<string | null>(null);
  // "Strikes around spot" band, same presets/semantics as the screener:
  // keep the N distinct strikes closest to spot within the selected expiration.
  const [nearSpot, setNearSpot] = useState('50');

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.symbolDetail(symbol)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setExpiration(d.expirations[0] ?? null);
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [symbol]);

  const u = detail?.underlying;
  const spot = u?.spot ?? null;

  // Set of strikes allowed by the near-spot band for the selected expiration,
  // or null when the band is disabled (All) / spot unknown / too few strikes.
  const bandStrikes = useMemo(() => {
    if (!detail || !expiration || spot == null) return null;
    const n = Number(nearSpot);
    if (!n || n <= 0) return null; // "All"
    const expStrikes = Array.from(new Set(
      detail.contracts.filter((c) => c.expiration === expiration).map((c) => c.strike)
    ));
    if (expStrikes.length <= n) return null; // keep everything
    const sorted = [...expStrikes].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
    return new Set(sorted.slice(0, n));
  }, [detail, expiration, spot, nearSpot]);

  const chain = useMemo(() => {
    if (!detail || !expiration) return [];
    const rows = buildChain(detail.contracts, expiration);
    return bandStrikes ? rows.filter((r) => bandStrikes.has(r.strike)) : rows;
  }, [detail, expiration, bandStrikes]);

  /** Strike closest to spot — the at-the-money row, highlighted in the chain. */
  const atmStrike = useMemo(() => {
    if (spot == null || chain.length === 0) return null;
    let best = chain[0].strike;
    let bestAbs = Math.abs(best - spot);
    for (const row of chain) {
      const d = Math.abs(row.strike - spot);
      if (d < bestAbs) { bestAbs = d; best = row.strike; }
    }
    return best;
  }, [chain, spot]);

  // Total distinct strikes for this expiration (ignoring the band), shown as
  // "(of N)" context next to the filtered strike count.
  const totalExpStrikes = useMemo(() => {
    if (!detail || !expiration) return 0;
    return new Set(
      detail.contracts.filter((c) => c.expiration === expiration).map((c) => c.strike)
    ).size;
  }, [detail, expiration]);

  const expStats = useMemo(() => {
    if (chain.length === 0) return null;
    let calls = 0, puts = 0, totalVol = 0, totalOI = 0;
    for (const { call, put } of chain) {
      if (call) { calls++; totalVol += call.volume ?? 0; totalOI += call.open_interest ?? 0; }
      if (put)  { puts++;  totalVol += put.volume  ?? 0; totalOI += put.open_interest  ?? 0; }
    }
    return { strikes: chain.length, calls, puts, totalVol, totalOI };
  }, [chain]);

  // 52w high/low + distance from the high, computed over the trailing-year bars.
  const ohlcStats = useMemo(() => {
    const bars = detail?.ohlc ?? [];
    if (bars.length === 0) return null;
    let high = -Infinity, low = Infinity;
    let hiDate = '', loDate = '';
    for (const b of bars) {
      if (b.high != null && b.high > high) { high = b.high; hiDate = b.date; }
      if (b.low != null && b.low < low) { low = b.low; loDate = b.date; }
    }
    const lastClose = bars[bars.length - 1].close ?? null;
    const offHigh = lastClose != null && high > 0 && Number.isFinite(high)
      ? ((lastClose - high) / high) * 100 : null;
    return {
      high: Number.isFinite(high) ? high : null,
      low: Number.isFinite(low) ? low : null,
      hiDate, loDate, offHigh, lastClose,
    };
  }, [detail?.ohlc]);

  // Newest-first view of the last 10 bars with % change vs the prior session.
  const recentBars = useMemo(() => {
    const bars = detail?.ohlc ?? [];
    return bars.slice(-10).reverse().map((b, i, arr) => {
      const prevClose = arr[i + 1]?.close ?? null; // next in reversed = prior day
      const chg = b.close != null && prevClose != null && prevClose !== 0
        ? ((b.close - prevClose) / prevClose) * 100 : null;
      return { ...b, chg };
    });
  }, [detail?.ohlc]);

  const rv = detail?.realized_vol ?? null;
  const corpActions = detail?.corporate_actions ?? [];

  return (
    <div className="symbol-detail">
      <div className="detail-bar">
        <button className="back-btn" onClick={onBack}>← Back to market</button>
        {u && (
          <div className="detail-title">
            <h2><b>{u.symbol}</b> <span className="muted">{u.name}</span></h2>
            <div className="detail-meta">
              {u.sector && <span className="chip">{u.sector}</span>}
              <span>Spot <b>{fmtNum(spot, 2)}</b></span>
              <span>{detail?.n_contracts.toLocaleString() ?? '–'} contracts</span>
              <span>{detail?.expirations.length ?? 0} expirations</span>
              {detail?.liquid === false && (
                <span className="chip illiquid" title="This underlying does not pass the global liquidity filter.">illiquid</span>
              )}
              {u.fetched_at && <span className="muted small">updated {u.fetched_at.slice(0, 19)}</span>}
            </div>
          </div>
        )}
      </div>

      {ohlcStats && (
        <div className="ohlc-panel">
          <div className="panel-title">Daily OHLC — trailing year</div>
          <div className="ohlc-stats">
            {ohlcStats.high != null && (
              <span>52w high <b>{fmtNum(ohlcStats.high)}</b>
                <span className="muted small">{ohlcStats.hiDate}</span>
              </span>
            )}
            {ohlcStats.low != null && (
              <span>52w low <b>{fmtNum(ohlcStats.low)}</b>
                <span className="muted small">{ohlcStats.loDate}</span>
              </span>
            )}
            {ohlcStats.offHigh != null && (
              <span title={`Last close ${fmtNum(ohlcStats.lastClose)} vs 52w high`}>
                off high{' '}
                <b className={ohlcStats.offHigh < 0 ? 'down' : 'up'}>
                  {fmtNum(ohlcStats.offHigh)}%
                </b>
              </span>
            )}
            {rv?.realized_vol_30d != null && (
              <span title={`Realized vol (annualized) over trailing ${rv.n_returns_30 ?? 30} sessions, as of ${rv.as_of_date}`}>
                RV30 <b>{fmtPct(rv.realized_vol_30d)}</b>
              </span>
            )}
            {rv?.realized_vol_90d != null && (
              <span title={`Realized vol (annualized) over trailing ${rv.n_returns_90 ?? 90} sessions, as of ${rv.as_of_date}`}>
                RV90 <b>{fmtPct(rv.realized_vol_90d)}</b>
              </span>
            )}
            {corpActions.map((a) => (
              <span key={`${a.ex_date}:${a.action_type}`}
                className={`chip ca-chip${a.action_type === 'SPLIT' ? ' ca-split' : ''}`}
                title={a.action_type === 'DIVIDEND'
                  ? `Ex-dividend ${fmtNum(a.amount)} per share`
                  : `Split ${a.numerator ?? '?'}:${a.denominator ?? '?'}`}
              >
                {a.action_type === 'DIVIDEND'
                  ? `Div ${a.ex_date} ${a.amount != null ? fmtNum(a.amount) : ''}`
                  : `Split ${a.ex_date} ${a.numerator ?? '?'}:${a.denominator ?? '?'}`}
              </span>
            ))}
          </div>
          <div className="ohlc-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={detail?.ohlc} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <XAxis
                  dataKey="date" axisLine={false} tickLine={false} minTickGap={48}
                  tick={{ fontSize: 10, fill: 'var(--muted)' }}
                  tickFormatter={(d: string) => d.slice(5)}
                />
                <YAxis
                  domain={['auto', 'auto']} axisLine={false} tickLine={false} width={48}
                  tick={{ fontSize: 10, fill: 'var(--muted)' }}
                  tickFormatter={(v: number) => fmtNum(v, 0)}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--panel-2)', border: '1px solid var(--border)',
                    borderRadius: 8, fontSize: 12, color: 'var(--text)',
                  }}
                  labelFormatter={(d) => `Close · ${String(d)}`}
                  formatter={(v) => [fmtNum(v as number, 2), 'close']}
                />
                {spot != null && (
                  <ReferenceLine y={spot} stroke="var(--accent)" strokeDasharray="3 3"
                    label={{ value: `spot ${fmtNum(spot)}`, position: 'insideTopRight', fontSize: 10, fill: 'var(--accent)' }}
                  />
                )}
                <Line type="monotone" dataKey="close" stroke="var(--accent)"
                  dot={false} strokeWidth={1.5} connectNulls isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {recentBars.length > 0 && (
            <div className="ohlc-table-wrap">
              <table className="ohlc-table">
                <thead>
                  <tr>
                    <th className="left">Date</th>
                    <th className="right">Open</th>
                    <th className="right">High</th>
                    <th className="right">Low</th>
                    <th className="right">Close</th>
                    <th className="right">Chg%</th>
                    <th className="right">Vol</th>
                  </tr>
                </thead>
                <tbody>
                  {recentBars.map((b) => (
                    <tr key={b.date}>
                      <td className="left muted">{b.date}</td>
                      <td className="right num">{fmtNum(b.open)}</td>
                      <td className="right num">{fmtNum(b.high)}</td>
                      <td className="right num">{fmtNum(b.low)}</td>
                      <td className="right num close-col">{fmtNum(b.close)}</td>
                      <td className={`right num ${b.chg == null ? '' : b.chg >= 0 ? 'up' : 'down'}`}>
                        {b.chg == null ? '–' : `${b.chg >= 0 ? '+' : ''}${fmtNum(b.chg)}%`}
                      </td>
                      <td className="right num">{fmtInt(b.volume)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {loading && <div className="muted">Loading {symbol}…</div>}
      {error && <div className="error">Error: {error}</div>}
      {detail && !detail.underlying && !loading && (
        <div className="error">No underlying found for {symbol}.</div>
      )}

      {detail?.expirations.length ? (
        <>
          <div className="expirations">
            <label className="label" htmlFor="exp-select">Expiration cycle</label>
            <select
              id="exp-select"
              className="exp-select"
              value={expiration ?? ''}
              onChange={(e) => setExpiration(e.target.value)}
            >
              {detail.expirations.map((e) => {
                const d = daysTo(e);
                return (
                  <option key={e} value={e}>
                    {dteLabel(d)} · {e} · {d} d
                  </option>
                );
              })}
            </select>
            {expiration && (
              <span className="dte-pill">{dteLabel(daysTo(expiration))}</span>
            )}
            <label className="label" htmlFor="nearspot-select">Strike window</label>
            <select
              id="nearspot-select"
              className="exp-select"
              value={nearSpot}
              onChange={(e) => setNearSpot(e.target.value)}
            >
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="0">All</option>
            </select>
          </div>

          {expStats && (
            <div className="exp-meta">
              <b>{expiration}</b> ({dteLabel(daysTo(expiration!))}) ·
              {' '}{expStats.strikes} strikes{bandStrikes && totalExpStrikes > expStats.strikes
                ? ` (of ${totalExpStrikes})` : ''} ·
              {' '}{expStats.calls.toLocaleString()} calls / {expStats.puts.toLocaleString()} puts ·
              {' '}vol <b>{expStats.totalVol.toLocaleString()}</b> ·
              {' '}OI <b>{expStats.totalOI.toLocaleString()}</b>
            </div>
          )}

          <div className="chain-wrap">
            <table className="chain">
              <thead>
                <tr>
                  <th colSpan={7} className="grp call-grp">CALLS</th>
                  <th className="strike-h">Strike</th>
                  <th colSpan={7} className="grp put-grp">PUTS</th>
                </tr>
                <tr className="sub-head">
                  <th className="right">Δ</th>
                  <th className="right">IV</th>
                  <th className="right">Vol</th>
                  <th className="right">OI</th>
                  <th className="right">Bid</th>
                  <th className="right">Ask</th>
                  <th className="right">Last</th>
                  <th className="strike-h">·</th>
                  <th className="right">Last</th>
                  <th className="right">Ask</th>
                  <th className="right">Bid</th>
                  <th className="right">OI</th>
                  <th className="right">Vol</th>
                  <th className="right">IV</th>
                  <th className="right">Δ</th>
                </tr>
              </thead>
              <tbody>
                {chain.map(({ strike, call, put }) => {
                  const callITM = call?.in_the_money;
                  const putITM = put?.in_the_money;
                  const moneyness = spot ? ((strike - spot) / spot) * 100 : null;
                  const isATM = atmStrike != null && strike === atmStrike;
                  return (
                    <tr key={strike} className={isATM ? 'atm-row' : undefined}>
                      {/* calls (left) */}
                      <td className={`right num ${callITM ? 'itm' : ''}`}>{fmtNum(call?.delta, 3)}</td>
                      <td className="right num">{fmtNum(call?.implied_vol, 3)}</td>
                      <td className="right num">{fmtInt(call?.volume)}</td>
                      <td className="right num">{fmtInt(call?.open_interest)}</td>
                      <td className="right num call-col">{fmtNum(call?.bid)}</td>
                      <td className="right num call-col">{fmtNum(call?.ask)}</td>
                      <td className="right num">{fmtNum(call?.last)}</td>
                      {/* strike (center) */}
                      <td className={`strike-cell${isATM ? ' strike-atm' : ''}`} title={moneyness !== null ? `${moneyness >= 0 ? '+' : ''}${moneyness.toFixed(1)}% vs spot` : ''}>
                        {fmtNum(strike, 0)}
                      </td>
                      {/* puts (right) */}
                      <td className="right num">{fmtNum(put?.last)}</td>
                      <td className="right num put-col">{fmtNum(put?.ask)}</td>
                      <td className="right num put-col">{fmtNum(put?.bid)}</td>
                      <td className="right num">{fmtInt(put?.open_interest)}</td>
                      <td className="right num">{fmtInt(put?.volume)}</td>
                      <td className="right num">{fmtNum(put?.implied_vol, 3)}</td>
                      <td className={`right num ${putITM ? 'itm' : ''}`}>{fmtNum(put?.delta, 3)}</td>
                    </tr>
                  );
                })}
                {chain.length === 0 && (
                  <tr><td colSpan={15} className="empty">No contracts for this expiration.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="chain-legend">
            <span className="dot call-dot" /> in-the-money cells shaded · strike center column ·
            hover a strike for moneyness vs spot
          </div>

          {spot != null && expiration && (
            <StrategiesPanel
              contracts={detail.contracts.filter((c) => c.expiration === expiration)}
              spot={spot}
              expiration={expiration}
              compact
            />
          )}
        </>
      ) : (detail && !loading && (
        <div className="empty">No option contracts for {symbol}.</div>
      ))}
    </div>
  );
}

export default SymbolDetail;
