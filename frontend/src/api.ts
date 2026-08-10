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

/** One headline from the Worker's /api/news proxy (Tavily news search). */
export interface NewsItem {
  title: string;
  link: string;
  published: string | null;
  snippet: string;
  source: 'tavily';
}

/** Response of /api/news — degrades to an empty item list with `error` on upstream failure. */
export interface NewsResponse {
  symbol: string;
  items: NewsItem[];
  source?: 'tavily';
  error?: string;
  fetched_at: string;
}

/** One result from the Worker's /api/web_search proxy (Tavily general search). */
export interface WebSearchResult {
  title: string;
  link: string;
  snippet: string;
  source: string | null;
}

/** Response of /api/web_search — degrades to an empty result list with `error` on upstream failure. */
export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  error?: string;
  fetched_at: string;
}

/** One scheduled macro/FOMC event from /api/econ_calendar. */
export interface EconCalendarEvent {
  date: string;
  title: string;
  kind: 'macro' | 'fed';
}

/** Response of /api/econ_calendar — degrades to `items: []` + `error`. */
export interface EconCalendarResponse {
  window_days: number;
  as_of: string;
  provider: 'fred' | 'federalreserve';
  items: EconCalendarEvent[];
  error?: string;
}

/** One daily ATM-IV point for /api/iv_rank (deduped per fetched_at date). */
export interface IvRankPoint {
  d: string;
  iv: number | null;
}

/** Response of /api/iv_rank — IV percentile vs a symbol's own history. */
export interface IvRankResponse {
  symbol: string;
  days: number;
  points: IvRankPoint[];
  rank_pct: number | null;
  iv_now: number | null;
  iv_median: number | null;
  iv_min: number | null;
  iv_max: number | null;
  as_of: string | null;
  error?: string;
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
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

/** Free anonymous chat credit (Worker /api/free/quota). */
export interface FreeQuota {
  remaining: number;
  limit: number;
  is_free_tier: boolean;
  model: string;
}

// ---------------------------------------------------------------------------
// Copilot chat history (Worker POST /api/chat/history → options.chat_history)
// ---------------------------------------------------------------------------
/** One message in a recorded transcript — stripped of bulky UI state (query result tables, chart specs, error stacks). */
export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  sql?: string;
  /** Epoch ms when the message was produced. */
  ts?: number;
}

/** Body of POST /api/chat/history. The Worker adds server-side fields (ip, user_agent) and never trusts them from the client. */
export interface ChatHistoryRecord {
  /** Per-conversation id (stable across turns; one row per turn records the full conversation so far). */
  chat_id: string;
  /** 'free' (site OpenRouter credit) | 'byok' (user key). */
  mode: 'free' | 'byok';
  model?: string;
  started_at: string;
  ended_at: string;
  messages: ChatHistoryMessage[];
}

/** Response of POST /api/chat/history — best-effort; `stored` is false when the pipeline is unavailable (buffered in D1). */
export interface ChatHistorySaveResponse {
  ok: boolean;
  stored: boolean;
  error?: string;
}

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
  // Per-ticker news headlines (Worker → Tavily news search).
  news: (symbol: string, limit?: number) =>
    get<NewsResponse>(`/api/news${qs({ symbol: symbol.toUpperCase(), limit })}`),
  // Open web search (Worker → Tavily general search), for fresh analyst/market
  // commentary beyond the per-ticker news feed.
  webSearch: (q: string, limit?: number) =>
    get<WebSearchResponse>(`/api/web_search${qs({ q, limit })}`),
  // IV rank / percentile vs a symbol's own ATM-IV history (Worker lake query).
  ivRank: (symbol: string, days?: number) =>
    get<IvRankResponse>(`/api/iv_rank${qs({ symbol: symbol.toUpperCase(), days })}`),
  // Upcoming macro/FOMC event dates (Worker → FRED releases/dates, Fed calendar fallback).
  econCalendar: (days?: number) =>
    get<EconCalendarResponse>(`/api/econ_calendar${qs({ days })}`),
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
  // Free anonymous chat credit (site OpenRouter key): remaining/limit model the
  // gate; 402 free_credit_exhausted from /api/free/* pivots the UI to BYOK.
  freeQuota: () => get<FreeQuota>('/api/free/quota'),
  loaderSymbols: (params?: {
    filter?: LoaderFilter;
    q?: string;
    limit?: number;
    offset?: number;
    sort?: 'symbol' | 'last_success_at' | 'consecutive_failures';
    order?: 'asc' | 'desc';
  }) => get<LoaderSymbolsResponse>(`/loader/symbols${qs(params ?? {})}`),
  // Save a completed Copilot chat turn to the lake (options.chat_history).
  // Best-effort: the Worker buffers into D1 when the pipeline hiccups, and
  // failures are swallowed by the caller — a chat is never blocked by history
  // persistence. The table itself is admin-only (see /api/admin/chat_history).
  saveChatHistory: (record: ChatHistoryRecord) =>
    post<ChatHistorySaveResponse>('/api/chat/history', record),
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
