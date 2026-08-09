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
  /** Up to 3 sample rows from the (D1-cached) lake schema; absent when the fetch predates samples. */
  sample?: Record<string, unknown>[];
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

/** One daily spot OHLC bar for an underlying (options.ohlc, newest run per date). */
export interface OhlcBar {
  date: string; // YYYY-MM-DD
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

/** Latest realized-volatility snapshot (options.realized_vol), annualized fractions. */
export interface RealizedVol {
  as_of_date: string;
  realized_vol_30d: number | null;
  realized_vol_90d: number | null;
  n_returns_30: number | null;
  n_returns_90: number | null;
}

/** Latest dividend/split row for an underlying (options.corporate_actions). */
export interface CorporateAction {
  action_type: 'DIVIDEND' | 'SPLIT';
  ex_date: string; // YYYY-MM-DD
  numerator: number | null; // split ratio, e.g. 4-for-1
  denominator: number | null;
  amount: number | null; // per-share cash dividend
}

/** One headline from the Worker's /api/news RSS proxy (Yahoo Finance ticker feed). */
export interface NewsItem {
  title: string;
  link: string;
  published: string | null;
  snippet: string;
}

/** Response of /api/news — degrades to an empty item list with `error` on upstream failure. */
export interface NewsResponse {
  symbol: string;
  items: NewsItem[];
  error?: string;
  fetched_at: string;
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
  // Enrichment from the OHLC pipeline (~1y of daily bars, latest realized-vol
  // snapshot, recent dividends/splits). Optional: older worker deploys omit
  // them; empty arrays when the tables have no rows for this symbol.
  ohlc?: OhlcBar[];
  realized_vol?: RealizedVol | null;
  corporate_actions?: CorporateAction[];
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
// Continuous loader live state (via the /loader/* screener pass-through).
// Timestamps are epoch-ms D1 INTEGERs; null when never recorded.
// ---------------------------------------------------------------------------
export interface LoaderStatus {
  ok: boolean;
  driver: string;
  counts: { total: number; enabled: number; due: number; failing: number };
  last_pass: {
    at: number;
    finished_at: number;
    run_id: string | null;
    attempted: number;
    succeeded: number;
    failed: number;
    batch: string[];
    transport_error: string | null;
    duration_ms: number;
  } | null;
  next_alarm: number | null;
  passing: boolean;
  market?: {
    open: boolean;
    reason?: 'open' | 'overnight' | 'after-hours' | 'weekend' | 'holiday';
    now_et?: string | null;
    next_open_et?: string | null;
  };
}

export type LoaderFilter = 'all' | 'failing' | 'retrying' | 'stale' | 'disabled';

export interface LoaderSymbol {
  symbol: string;
  enabled: number;
  last_success_at: number | null;
  last_attempt_at: number | null;
  consecutive_failures: number;
  next_attempt_after: number;
  backoff_seconds: number;
  last_error: string | null;
}

export interface LoaderSymbolsResponse {
  ok: boolean;
  total: number;
  items: LoaderSymbol[];
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
  // Full symbol universe (names/sectors) for the cross-session typeahead cache;
  // the server caps at 1000 and the lake holds ~500 underlyings.
  symbolsAll: (liquid_only?: boolean) =>
    get<SymbolSuggestion[]>(`/api/symbols${qs({ liquid_only, limit: 1000 })}`),
  liquidity: () => get<LiquidityInfo>('/api/liquidity'),
  screen: (params: Record<string, string | number | boolean | undefined>) =>
    get<ScreenResponse>(`/api/screen${qs(params)}`),
  // Lake schema, served from the Worker's D1 cache (recomputed when stale).
  // `force` skips the cache and recomputes live from the lake (SQL Lab refresh).
  tables: (opts?: { force?: boolean }) =>
    get<TableInfo[]>(`/api/tables${qs({ force: opts?.force ? 1 : undefined })}`),
  query: (sql: string, limit?: number) => post<QueryResult>('/api/query', { sql, limit }),
  // Per-ticker news headlines (Worker → Yahoo Finance RSS proxy, keyless).
  news: (symbol: string, limit?: number) =>
    get<NewsResponse>(`/api/news${qs({ symbol: symbol.toUpperCase(), limit })}`),
  symbolDetail: (symbol: string) => get<SymbolDetail>(`/api/symbol/${encodeURIComponent(symbol.toUpperCase())}`),
  notebookPremium: (params: {
    target_dte?: number;
    tolerance?: number;
    moneyness_band?: number;
    min_volume?: number;
    liquid_only?: boolean;
    limit?: number;
  }) => get<PremiumNotebook>(`/api/notebook/premium${qs(params)}`),
  loaderStatus: () => get<LoaderStatus>('/loader/status'),
  loaderSymbols: (params?: {
    filter?: LoaderFilter;
    q?: string;
    limit?: number;
    offset?: number;
    sort?: 'symbol' | 'last_success_at' | 'consecutive_failures';
    order?: 'asc' | 'desc';
  }) => get<LoaderSymbolsResponse>(`/loader/symbols${qs(params ?? {})}`),
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
