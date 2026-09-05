import { useEffect, useMemo, useState } from 'react';
import { HStack, Text, Tooltip as AstryxTooltip, VStack } from '@astryxdesign/core';
import type { ChainContract } from './api';
import { etDateString } from './tickerChartRange';
import './Research.css';

function fmtNum(v: number | null | undefined, d = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtInt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString();
}

function buildChain(contracts: ChainContract[], expiration: string) {
  const expContracts = contracts.filter((c) => c.expiration === expiration);
  const byStrike = new Map<number, { call?: ChainContract; put?: ChainContract }>();
  for (const c of expContracts) {
    let entry = byStrike.get(c.strike);
    if (!entry) {
      entry = {};
      byStrike.set(c.strike, entry);
    }
    if (c.type === 'call') entry.call = c;
    else entry.put = c;
  }
  return [...byStrike.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([strike, pair]) => ({ strike, ...pair }));
}

function daysTo(expiration: string, asOf?: string): number {
  const d = new Date(`${expiration}T12:00:00`);
  const now = asOf ? new Date(`${asOf}T12:00:00`) : new Date();
  return Math.round((d.getTime() - now.getTime()) / 86_400_000);
}

function dteLabel(days: number): string {
  const abs = Math.abs(days);
  if (abs === 0) return '0 DTE';
  const sign = days < 0 ? '−' : '';
  if (abs < 60) return `${sign}${abs} DTE`;
  if (abs < 365) return `${sign}${(abs / 30.44).toFixed(1)} mo`;
  return `${sign}${(abs / 365.25).toFixed(1)} yr`;
}

export function TickerOptionsChain({
  contracts,
  expirations,
  spot,
  asOf,
  expiration,
  nearSpot: nearSpotProp,
  onExpirationChange,
  onNearSpotChange,
  loading = false,
}: {
  contracts: ChainContract[];
  expirations: string[];
  spot: number | null;
  /** ET calendar day used for DTE and the first unexpired expiry. */
  asOf?: string;
  /** Controlled expiration (server-scoped fetch). */
  expiration?: string;
  /** Controlled near-spot window; 0 = all strikes for the active expiry. */
  nearSpot?: number;
  onExpirationChange?: (expiration: string) => void;
  onNearSpotChange?: (nearSpot: number) => void;
  loading?: boolean;
}) {
  const controlled = Boolean(onExpirationChange);
  const [localExpiration, setLocalExpiration] = useState(expiration ?? expirations[0] ?? '');
  const [localNearSpot, setLocalNearSpot] = useState(String(nearSpotProp ?? 50));

  useEffect(() => {
    if (!controlled) setLocalExpiration(expiration ?? expirations[0] ?? '');
  }, [controlled, expiration, expirations]);

  useEffect(() => {
    if (nearSpotProp != null) setLocalNearSpot(String(nearSpotProp));
  }, [nearSpotProp]);

  const today = asOf ?? etDateString();
  const firstOpen = expirations.find((e) => e >= today);
  const activeExpiration = controlled
    ? (expiration && expirations.includes(expiration)
      ? expiration
      : (firstOpen ?? expirations[expirations.length - 1] ?? ''))
    : (localExpiration && expirations.includes(localExpiration)
      ? localExpiration
      : (firstOpen ?? expirations[0] ?? ''));

  const nearSpot = controlled ? String(nearSpotProp ?? 50) : localNearSpot;

  // When the parent scopes the fetch server-side, contracts are already trimmed —
  // don't re-window client-side (we'd hide strikes the server already selected).
  const serverScoped = controlled;

  const bandStrikes = useMemo(() => {
    if (serverScoped || !activeExpiration || spot == null) return null;
    const n = Number(nearSpot);
    if (!n || n <= 0) return null;
    const expStrikes = [...new Set(
      contracts.filter((c) => c.expiration === activeExpiration).map((c) => c.strike),
    )];
    if (expStrikes.length <= n) return null;
    const sorted = [...expStrikes].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
    return new Set(sorted.slice(0, n));
  }, [serverScoped, contracts, activeExpiration, spot, nearSpot]);

  const chain = useMemo(() => {
    if (!activeExpiration) return [];
    const rows = buildChain(contracts, activeExpiration);
    return bandStrikes ? rows.filter((r) => bandStrikes.has(r.strike)) : rows;
  }, [contracts, activeExpiration, bandStrikes]);

  const atmStrike = useMemo(() => {
    if (spot == null || chain.length === 0) return null;
    let best = chain[0].strike;
    let bestAbs = Math.abs(best - spot);
    for (const row of chain) {
      const d = Math.abs(row.strike - spot);
      if (d < bestAbs) {
        bestAbs = d;
        best = row.strike;
      }
    }
    return best;
  }, [chain, spot]);

  const setExpiration = (value: string) => {
    if (onExpirationChange) onExpirationChange(value);
    else setLocalExpiration(value);
  };

  const setNearSpot = (value: string) => {
    setLocalNearSpot(value);
    if (onNearSpotChange) onNearSpotChange(Number(value) || 0);
  };

  if (expirations.length === 0) {
    return (
      <VStack gap={2} className="research-chain">
        <Text type="supporting">
          {loading ? 'Loading option contracts…' : 'No option contracts for this underlying in the latest run.'}
        </Text>
      </VStack>
    );
  }

  return (
    <VStack gap={3} className="research-chain">
      <HStack gap={3} vAlign="end" wrap="wrap" className="research-chain-controls">
        <label className="research-field">
          <span className="research-field-label">Expiration</span>
          <select
            className="research-select"
            value={activeExpiration}
            onChange={(e) => setExpiration(e.target.value)}
            aria-label="Option expiration"
          >
            {expirations.map((exp) => (
              <option key={exp} value={exp}>
                {dteLabel(daysTo(exp, asOf))} · {exp}
              </option>
            ))}
          </select>
        </label>
        <label className="research-field">
          <span className="research-field-label">Strike window</span>
          <select
            className="research-select research-select-narrow"
            value={nearSpot}
            onChange={(e) => setNearSpot(e.target.value)}
            aria-label="Strikes near spot"
          >
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
            <option value="0">All</option>
          </select>
        </label>
        <Text type="supporting" className="research-chain-meta">
          {loading ? 'Refreshing… · ' : ''}
          {chain.length} strikes
          {activeExpiration ? ` · ${dteLabel(daysTo(activeExpiration, asOf))}` : ''}
        </Text>
      </HStack>

      <div className="research-chain-wrap">
        <table className="research-chain-table">
          <thead>
            <tr>
              <th colSpan={7} className="grp call-grp">Calls</th>
              <th className="strike-h">Strike</th>
              <th colSpan={7} className="grp put-grp">Puts</th>
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
              const moneyness = spot != null ? ((strike - spot) / spot) * 100 : null;
              const isAtm = atmStrike != null && strike === atmStrike;
              return (
                <tr key={strike} className={isAtm ? 'atm-row' : undefined}>
                  <td className={`right num ${call?.in_the_money ? 'itm' : ''}`}>{fmtNum(call?.delta, 3)}</td>
                  <td className="right num">{fmtNum(call?.implied_vol, 3)}</td>
                  <td className="right num">{fmtInt(call?.volume)}</td>
                  <td className="right num">{fmtInt(call?.open_interest)}</td>
                  <td className="right num call-col">{fmtNum(call?.bid)}</td>
                  <td className="right num call-col">{fmtNum(call?.ask)}</td>
                  <td className="right num">{fmtNum(call?.last)}</td>
                  <td className={`strike-cell${isAtm ? ' strike-atm' : ''}`}>
                    <AstryxTooltip
                      content={moneyness == null ? '' : `${moneyness >= 0 ? '+' : ''}${moneyness.toFixed(1)}% vs spot`}
                      isEnabled={moneyness != null}
                      hasHoverIndication={false}
                    >
                      <span>{fmtNum(strike, 0)}</span>
                    </AstryxTooltip>
                  </td>
                  <td className="right num">{fmtNum(put?.last)}</td>
                  <td className="right num put-col">{fmtNum(put?.ask)}</td>
                  <td className="right num put-col">{fmtNum(put?.bid)}</td>
                  <td className="right num">{fmtInt(put?.open_interest)}</td>
                  <td className="right num">{fmtInt(put?.volume)}</td>
                  <td className="right num">{fmtNum(put?.implied_vol, 3)}</td>
                  <td className={`right num ${put?.in_the_money ? 'itm' : ''}`}>{fmtNum(put?.delta, 3)}</td>
                </tr>
              );
            })}
            {chain.length === 0 && (
              <tr>
                <td colSpan={15} className="empty">
                  {loading ? 'Loading contracts…' : 'No contracts for this expiration.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Text type="supporting" className="research-chain-legend">
        ITM cells shaded · ATM row highlighted · hover strike for moneyness
      </Text>
    </VStack>
  );
}
