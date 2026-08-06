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

// The API layer now runs entirely in-browser: each method delegates to the
// corresponding function in `server.ts` (a 1:1 port of backend/screener/server.py)
// which executes the same SQL against the DuckDB-WASM instance in `db.ts`.
// The exported types above are unchanged, so the UI components need no edits.
import { ready as dbReady } from './db';
import * as server from './server';

export const api = {
  /** Resolves once DuckDB-WASM has loaded the dataset views. */
  ready: () => dbReady,
  stats: (liquid_only?: boolean) => server.stats(!!liquid_only),
  sectors: (liquid_only?: boolean) => server.sectors(!!liquid_only),
  symbols: (q: string, liquid_only?: boolean) =>
    server.symbols({ q: q || undefined, liquid_only: !!liquid_only }),
  liquidity: () => server.liquidity(),
  screen: (params: Record<string, string | number | boolean | undefined>) =>
    server.screen({
      symbol: params.symbol as string | undefined,
      type: params.type as 'call' | 'put' | undefined,
      sector: params.sector as string | undefined,
      min_strike: params.min_strike as number | undefined,
      max_strike: params.max_strike as number | undefined,
      min_volume: params.min_volume as number | undefined,
      min_open_interest: params.min_open_interest as number | undefined,
      min_iv: params.min_iv as number | undefined,
      max_iv: params.max_iv as number | undefined,
      min_delta: params.min_delta as number | undefined,
      max_delta: params.max_delta as number | undefined,
      in_the_money: params.in_the_money as boolean | undefined,
      expiration_before: params.expiration_before as string | undefined,
      expiration_after: params.expiration_after as string | undefined,
      liquid_only: params.liquid_only as boolean | undefined,
      near_spot_strikes: params.near_spot_strikes as number | undefined,
      sort: params.sort as string | undefined,
      order: params.order as 'asc' | 'desc' | undefined,
      limit: params.limit as number | undefined,
      offset: params.offset as number | undefined,
    }),
  tables: () => server.tables(),
  query: (sql: string, limit?: number) => server.runQuery({ sql, limit }),
  symbolDetail: (symbol: string) => server.symbolDetail(symbol.toUpperCase()),
  notebookPremium: (params: {
    target_dte?: number;
    tolerance?: number;
    moneyness_band?: number;
    min_volume?: number;
    liquid_only?: boolean;
    limit?: number;
  }) => server.notebookPremium(params),
};

import { useState, useEffect } from 'react';

/** React hook that exposes the DuckDB-WASM readiness state for a loading gate. */
export function useDbReady(): { ready: boolean; error: string | null } {
  const [state, setState] = useState<{ ready: boolean; error: string | null }>({
    ready: false,
    error: null,
  });
  useEffect(() => {
    let cancelled = false;
    dbReady
      .then(() => !cancelled && setState({ ready: true, error: null }))
      .catch((e) => !cancelled && setState({ ready: false, error: String(e) }));
    return () => { cancelled = true; };
  }, []);
  return state;
}
