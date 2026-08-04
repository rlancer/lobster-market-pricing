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
  stats: () => getJson<Stats>('/api/stats'),
  sectors: () => getJson<SectorRow[]>('/api/sectors'),
  symbols: (q: string) => getJson<SymbolSuggestion[]>(`/api/symbols?q=${encodeURIComponent(q)}`),
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
    getJson<SymbolDetail>(`/api/symbol/${encodeURIComponent(symbol.toUpperCase())}`),
};
