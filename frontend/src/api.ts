export interface Stats {
  underlyings: number;
  contracts: number;
  calls: number;
  puts: number;
  last_updated: string;
}
export interface Underlying {
  symbol: string;
  name: string;
  sector: string;
  spot: number | null;
  contracts: number;
}

export interface OptionRow {
  symbol: string;
  name: string | null;
  sector: string | null;
  spot: number | null;
  expiration: string;
  type: 'call' | 'put';
  strike: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  open_interest: number | null;
  implied_vol: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  in_the_money: boolean | null;
  // CBOE-delivered columns (hard cutover from Yahoo): theoretical price +
  // quoted bid/ask sizes. Optional so callers that don't select them still typecheck.
  theo?: number | null;
  bid_size?: number | null;
  ask_size?: number | null;
  moneyness_pct: number | null;
}

export interface ScreenResponse {
  total: number;
  items: OptionRow[];
  truncated?: boolean;
}

export interface RefreshRun {
  run_id: string;
  started_at: string;
  completed_at: string | null;
  as_of_date: string;
  expected_symbols: number;
  successful_symbols: number;
  failed_symbols: number;
  contract_count: number;
  status: string;
  error_summary: string | null;
}

export interface LiquidityCriteria {
  min_volume: number;
  min_open_interest: number;
  max_spread: number;
  atm_band: number;
  min_atm_contracts: number;
}

export interface LiquidityInfo {
  enabled_defaults: LiquidityCriteria;
  total_underlyings: number;
  liquid_underlyings: number;
  description: string;
}

export interface SymbolSuggestion {
  symbol: string;
  name: string | null;
  sector: string | null;
}

export interface SectorRow {
  sector: string;
  symbols: number;
  avg_spot: number | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface TableInfo {
  name: string;
  row_count: number | null;
  columns: ColumnInfo[];
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated?: boolean;
  limit?: number;
  error?: string;
}

export interface ChainContract {
  expiration: string;
  type: 'call' | 'put';
  strike: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  open_interest: number | null;
  implied_vol: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  in_the_money: boolean | null;
  // CBOE-delivered columns (see OptionRow).
  theo?: number | null;
  bid_size?: number | null;
  ask_size?: number | null;
}

export interface SymbolDetail {
  underlying: {
    symbol: string;
    name: string | null;
    sector: string | null;
    spot: number | null;
    fetched_at: string | null;
  } | null;
  contracts: ChainContract[];
  expirations: string[];
  n_contracts: number;
  liquid: boolean;
}

export interface PremiumNotebookRow {
  symbol: string;
  name: string | null;
  sector: string | null;
  spot: number | null;
  expiration: string;
  type: 'call' | 'put';
  strike: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  open_interest: number | null;
  implied_vol: number | null;
  delta: number | null;
  in_the_money: boolean | null;
  premium: number | null;
  moneyness: number | null;
  premium_ratio: number | null;
}

export interface PremiumNotebook {
  notebook: string;
  target_dte: number;
  tolerance: number;
  moneyness_band: number;
  min_volume: number;
  calls: PremiumNotebookRow[];
  puts: PremiumNotebookRow[];
}

// ---------------------------------------------------------------------------
// API client — fetches the screener-api Cloudflare Worker (R2 SQL backend).
// The exported types above are unchanged from the in-browser DuckDB-WASM era,
// so the UI components need no edits. `VITE_API_BASE` (frontend/.env) points at
// the deployed Worker URL; in local dev it can point at `http://127.0.0.1:8787`
// or be left empty to use the Vite `/api` proxy.
// ---------------------------------------------------------------------------
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

async function get<T>(path: string): Promise<T> {
  const r = await fetch(API_BASE + path);
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text().catch(() => r.statusText)}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text().catch(() => r.statusText)}`);
  return r.json() as Promise<T>;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v))) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  /** No-op readiness: the Worker is always ready (was the DuckDB-WASM load gate). */
  ready: () => Promise.resolve(),
  stats: (liquid_only?: boolean) => get<Stats>(`/api/stats${qs({ liquid_only })}`),
  runs: (limit?: number) => get<RefreshRun[]>(`/api/runs${qs({ limit })}`),
  sectors: (liquid_only?: boolean) => get<SectorRow[]>(`/api/sectors${qs({ liquid_only })}`),
  symbols: (q: string, liquid_only?: boolean) =>
    get<SymbolSuggestion[]>(`/api/symbols${qs({ q: q || undefined, liquid_only })}`),
  liquidity: () => get<LiquidityInfo>('/api/liquidity'),
  screen: (params: Record<string, string | number | boolean | undefined>) =>
    get<ScreenResponse>(`/api/screen${qs(params)}`),
  tables: () => get<TableInfo[]>('/api/tables'),
  query: (sql: string, limit?: number) => post<QueryResult>('/api/query', { sql, limit }),
  symbolDetail: (symbol: string) => get<SymbolDetail>(`/api/symbol/${encodeURIComponent(symbol.toUpperCase())}`),
  notebookPremium: (params: {
    target_dte?: number;
    tolerance?: number;
    moneyness_band?: number;
    min_volume?: number;
    liquid_only?: boolean;
    limit?: number;
  }) => get<PremiumNotebook>(`/api/notebook/premium${qs(params)}`),
};

import { useState, useEffect } from 'react';

/**
 * Readiness hook. With the Worker backend there is no in-browser dataset to
 * load, so this is always ready. Kept for backwards compatibility with the
 * DuckDB-WASM-era App.tsx loading gate.
 */
export function useDbReady(): { ready: boolean; error: string | null } {
  const [state, setState] = useState<{ ready: boolean; error: string | null }>({
    ready: true,
    error: null,
  });
  useEffect(() => {
    setState({ ready: true, error: null });
  }, []);
  return state;
}
