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

const apiBase = ''; // proxied via vite dev server

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(apiBase + url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(apiBase + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  stats: (liquid_only?: boolean) =>
    getJson<Stats>(`/api/stats${liquid_only ? '?liquid_only=true' : ''}`),
  sectors: (liquid_only?: boolean) =>
    getJson<SectorRow[]>(`/api/sectors${liquid_only ? '?liquid_only=true' : ''}`),
  symbols: (q: string, liquid_only?: boolean) => {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (liquid_only) qs.set('liquid_only', 'true');
    return getJson<SymbolSuggestion[]>(`/api/symbols?${qs.toString()}`);
  },
  liquidity: () => getJson<LiquidityInfo>('/api/liquidity'),
  screen: (params: Record<string, string | number | boolean | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '' && v !== null && !(typeof v === 'number' && Number.isNaN(v))) {
        qs.set(k, String(v));
      }
    }
    return getJson<ScreenResponse>(`/api/screen?${qs.toString()}`);
  },
  tables: () => getJson<TableInfo[]>('/api/tables'),
  query: (sql: string, limit?: number) =>
    postJson<QueryResult>('/api/query', { sql, limit }),
  symbolDetail: (symbol: string) =>
    getJson<SymbolDetail>(`/api/symbol/${encodeURIComponent(symbol.toUpperCase())}`),  notebookPremium: (params: {
    target_dte?: number;
    tolerance?: number;
    moneyness_band?: number;
    min_volume?: number;
    liquid_only?: boolean;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))) {
        qs.set(k, String(v));
      }
    }
    return getJson<PremiumNotebook>(`/api/notebook/premium?${qs.toString()}`);
  },
};
