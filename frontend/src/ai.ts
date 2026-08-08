// AI copilot for the options screener.
// Runs entirely client-side (BYOK): the user's OpenRouter API key is stored in
// localStorage and sent directly from the browser to OpenRouter — no backend
// proxy, no per-user billing for the site owner.
//
// Flow per question (TanStack AI agent loop):
//   1. Gather schema context (tables, columns, types, row counts, sample rows)
//      via the Worker.
//   2. Ask an agent (chat() + `run_query` + `check_schema` tools) to answer the
//      question. The model writes DataFusion (R2 SQL); every proposed query is
//      deterministically validated against the real schema (unknown tables /
//      columns rejected with a precise message), executed against the CBOE
//      Iceberg lake via the Worker's /api/query, summarized, and any error is
//      fixed by calling the tool again — all inside the agent loop.
//   3. Return { answer, sql, result } (last executed SQL + result for the UI).

import { chat, toolDefinition, maxIterations } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { z } from 'zod';
import { api } from './api';
import type { QueryResult } from './api';
import type { ChartSpec } from './Chart';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const APP_TITLE = 'Open Interest Options Workspace';

// ---------------------------------------------------------------------------
// Credential / model helpers (localStorage)
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'openinterest_ai_key';
const MODEL_KEY = 'openinterest_ai_model';
// Fresh users default to a free (:free) model so a $0 OpenRouter account works
// out of the box — no deposit or credit card needed to start chatting.
const DEFAULT_MODEL = 'google/gemma-4-31b-it:free';

export function getApiKey(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}
export function setApiKey(k: string): void {
  localStorage.setItem(STORAGE_KEY, k.trim());
}
export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}
export function getModel(): string {
  return localStorage.getItem(MODEL_KEY) ?? DEFAULT_MODEL;
}
export function setModel(m: string): void {
  localStorage.setItem(MODEL_KEY, m.trim());
}

// ---------------------------------------------------------------------------
// Reasoning-effort preference (localStorage)
// ---------------------------------------------------------------------------
// OpenAI-style reasoning models (e.g. openai/gpt-5.6-luna) accept an optional
// `reasoning_effort` of low/medium/high via OpenRouter. Not every model accepts
// it, so senders must check `modelSupports(model, 'reasoning_effort')` first.
export type ReasoningEffort = 'low' | 'medium' | 'high';
const EFFORT_KEY = 'openinterest_ai_effort';
const DEFAULT_EFFORT: ReasoningEffort = 'medium';
const EFFORT_VALUES = ['low', 'medium', 'high'] as const;

export function getEffort(): ReasoningEffort {
  const v = localStorage.getItem(EFFORT_KEY);
  return (EFFORT_VALUES as readonly string[]).includes(v ?? '') ? (v as ReasoningEffort) : DEFAULT_EFFORT;
}
export function setEffort(e: ReasoningEffort): void {
  localStorage.setItem(EFFORT_KEY, e);
}

// ---------------------------------------------------------------------------
// Model catalog (OpenRouter /models, filtered for the pilot agent)
// ---------------------------------------------------------------------------
// The Copilot runs a TanStack AI agent that needs function/tool calling, and we
// only want live, current models. OpenRouter's public /models endpoint (no key
// required) exposes `supported_parameters` (does it accept tools?) and `created`
// (epoch seconds) per model, so we surface tool-capable models released within
// the last ~6 months and group them by provider.
export interface ModelChoice {
  value: string;
  label: string;
}
export interface ModelGroup {
  title: string;
  options: ModelChoice[];
}

interface CatalogModel {
  id: string;
  name?: string;
  created?: number;
  supported_parameters?: string[];
  architecture?: {
    output_modalities?: string[];
  };
}

// Curated fallback (used if the live fetch fails / app is offline). Also
// guarantees `openrouter/auto` is always offered — it's a routing alias, not an
// entry in the /models catalog.
export const FALLBACK_MODEL_GROUPS: ModelGroup[] = [
  {
    title: 'Free',
    options: [
      { value: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B Instruct (free)' },
      { value: 'openai/gpt-oss-20b:free', label: 'GPT-OSS 20B (free)' },
      { value: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B (free)' },
    ],
  },
  {
    title: 'Anthropic',
    options: [
      { value: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
      { value: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku' },
    ],
  },
  {
    title: 'OpenAI',
    options: [
      { value: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
      { value: 'openai/gpt-4o', label: 'GPT-4o' },
    ],
  },
  {
    title: 'Google',
    options: [{ value: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' }],
  },
  {
    title: 'Meta',
    options: [{ value: 'meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B' }],
  },
  {
    title: 'Auto',
    options: [{ value: 'openrouter/auto', label: 'OpenRouter auto' }],
  },
];

const MODELS_RECENCY_MS = 1000 * 60 * 60 * 24 * 30 * 6; // ~6 months
const toolCapable = (m: CatalogModel): boolean =>
  Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools');
const isRecent = (m: CatalogModel): boolean =>
  typeof m.created === 'number' && Date.now() - m.created * 1000 < MODELS_RECENCY_MS;
// Exclude image-generation models (e.g. dalle/flux/gemini-*-image): they don't
// belong in a chat model picker. Only OUTPUT modality matters — vision input on
// a text-output chat model is fine.
const hasImageOutput = (m: CatalogModel): boolean =>
  Array.isArray(m.architecture?.output_modalities) &&
  m.architecture.output_modalities.includes('image');

// Model id → supported_parameters, filled from the live /models catalog so callers
// only send provider-specific options to models that accept them. Empty/unknown
// models conservatively report "not supported".
const modelSupportedParams = new Map<string, string[]>();

/** True when the catalog says `model` accepts the given parameter (e.g. 'reasoning_effort'). */
export function modelSupports(model: string, param: string): boolean {
  return modelSupportedParams.get(model)?.includes(param) ?? false;
}

/** True once the catalog has authoritative params for `model` (false while loading / unknown / fetch failed). */
export function modelHasParams(model: string): boolean {
  return modelSupportedParams.has(model);
}

async function fetchOpenRouterModels(): Promise<ModelGroup[]> {
  const res = await fetch(`${OPENROUTER_BASE}/models`);
  if (!res.ok) throw new Error(`Failed to load OpenRouter models (${res.status})`);
  const json = (await res.json()) as { data?: CatalogModel[] };

  const qualified = (json.data ?? []).filter(
    (m): m is CatalogModel =>
      !!m && typeof m.id === 'string' && toolCapable(m) && isRecent(m) && !hasImageOutput(m),
  );
  // Record per-model supported_parameters so senders know which provider-specific
  // options (e.g. reasoning_effort) each model actually accepts.
  for (const m of qualified) modelSupportedParams.set(m.id, m.supported_parameters ?? []);

  const choices = qualified
    // Strip the redundant "{Provider}: " prefix from OpenRouter's display name
    // since options are already grouped into provider sections.
    .map((m): ModelChoice => ({
      value: m.id,
      label: (m.name && m.name.replace(/^[^:]+:\s*/, '')) || m.id,
    }))
    .sort((a, b) => a.value.localeCompare(b.value));

  // OpenRouter's `:free` tier needs no balance. Surface those first as their own
  // "Free" group (and out of the paid provider groups) so a $0 account can chat
  // immediately. They still carry full supported_parameters via modelSupportedParams.
  const isFree = (id: string): boolean => id.endsWith(':free');
  const free = choices.filter((c) => isFree(c.value));
  const paid = choices.filter((c) => !isFree(c.value));

  const byProvider = new Map<string, ModelChoice[]>();
  for (const c of paid) {
    const slash = c.value.indexOf('/');
    const provider = slash > 0 ? c.value.slice(0, slash) : 'other';
    const list = byProvider.get(provider);
    if (list) list.push(c);
    else byProvider.set(provider, [c]);
  }

  const groups: ModelGroup[] = [];
  if (free.length) {
    groups.push({ title: 'Free', options: free });
  }
  groups.push({ title: 'Auto', options: [{ value: 'openrouter/auto', label: 'OpenRouter auto' }] });
  for (const [provider, options] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    groups.push({ title: provider, options });
  }
  return groups;
}

/** Best-effort live load; rejects so callers can fall back to FALLBACK_MODEL_GROUPS. */
export async function fetchAvailableModels(): Promise<ModelGroup[]> {
  return fetchOpenRouterModels();
}

// ---------------------------------------------------------------------------
// OpenRouter OAuth (PKCE) "connect" flow
// ---------------------------------------------------------------------------
// Instead of asking users to hand-paste an API key, they can click a
// "Connect with OpenRouter" button. We bounce them to openrouter.ai/auth;
// after they log in + authorize, OpenRouter redirects back with a short-lived
// `code`. We exchange that code for a user-controlled API key and store it in
// localStorage (same place as a manually-entered key) — it never touches our
// server. The user can revoke the key from their OpenRouter dashboard.
//
// Docs: https://openrouter.ai/docs/guides/overview/auth/oauth.md

const OAUTH_SESSION_KEY = 'openinterest_oauth_verifier';
const OAUTH_CALLBACK_PARAM = 'oauth_callback';

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a cryptographically-random URL-safe string (127 chars). */
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** SHA-256 hash of the verifier -> base64url challenge (for S256). */
async function sha256CodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64Url(new Uint8Array(hash));
}

/**
 * Kick off the OpenRouter PKCE flow: save the verifier, then redirect to
 * OpenRouter's auth page. The callback URL is this same origin with a
 * `?oauth_callback=1` marker so the app can detect the return trip.
 */
export async function startOAuthFlow(): Promise<void> {
  const verifier = generateCodeVerifier();
  sessionStorage.setItem(OAUTH_SESSION_KEY, verifier);
  const challenge = await sha256CodeChallenge(verifier);
  // Land the redirect back on the Copilot route (/ai), not the site root, so
  // the path itself restores the tab after the full-page OAuth round trip.
  const callbackUrl = `${window.location.origin}/ai?${OAUTH_CALLBACK_PARAM}=1`;
  const authUrl =
    'https://openrouter.ai/auth?' +
    `callback_url=${encodeURIComponent(callbackUrl)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    '&code_challenge_method=S256';
  window.location.href = authUrl;
}

/** Detect whether the current URL is an OpenRouter OAuth callback. */
export function isOAuthCallback(): boolean {
  const p = new URLSearchParams(window.location.search);
  // OpenRouter appends `?code=...` to the redirect URL but drops the
  // `oauth_callback=1` marker we put in the callback_url (observed live:
  // it returned `/ai?code=…` with no marker). So detect the return trip by
  // the `code` param; keep the marker check only as defense in depth.
  return p.has('code') || p.get(OAUTH_CALLBACK_PARAM) === '1';
}

/**
 * If the current URL is an OAuth callback, exchange the `code` for an API key,
 * store it, strip the callback params from the URL, and return true.
 * Returns false if there is no callback to handle.
 */
export async function handleOAuthCallback(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  // OpenRouter drops the `oauth_callback=1` marker (only `?code=…` survives),
  // so the presence of `code` alone identifies the return trip.
  if (!code && params.get(OAUTH_CALLBACK_PARAM) !== '1') return false;

  const verifier = sessionStorage.getItem(OAUTH_SESSION_KEY);
  sessionStorage.removeItem(OAUTH_SESSION_KEY);

  // Always clean the callback params from the URL once we've seen them.
  params.delete(OAUTH_CALLBACK_PARAM);
  params.delete('code');
  const qs = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${qs ? `?${qs}` : ''}`,
  );

  console.log('[OpenRouter OAuth] callback code:', code);

  if (!code) throw new Error('OAuth callback missing the authorization code.');

  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: 'S256',
    }),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j?.error?.message ?? j?.message ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(`OpenRouter connect failed (${res.status}): ${detail}`);
  }

  const j = await res.json();
  const key = j?.key;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('OpenRouter did not return an API key.');
  }
  setApiKey(key);
  console.log(
    `[OpenRouter OAuth] API key stored in localStorage (len=${key.length}); ` +
      `chat is configured.`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Schema context builder
// ---------------------------------------------------------------------------
export interface SchemaTable {
  name: string;
  row_count: number | null;
  columns: { name: string; type: string }[];
  sample: Record<string, unknown>[];
}
export interface SchemaContext {
  tables: SchemaTable[];
}

export async function buildSchemaContext(): Promise<SchemaContext> {
  const tables = await api.tables();
  const out: SchemaTable[] = [];
  for (const t of tables) {
    let sample: Record<string, unknown>[] = [];
    try {
      const r = await api.query(`SELECT * FROM options."${t.name}" LIMIT 3`, 3);
      sample = r.rows;
    } catch {
      /* non-fatal: sample is optional */
    }
    out.push({ name: t.name, row_count: t.row_count, columns: t.columns, sample });
  }
  return { tables: out };
}

function schemaToPrompt(ctx: SchemaContext): string {
  return ctx.tables
    .map((t) => {
      const size =
        t.row_count == null
          ? ''
          : `  row_count: ${t.row_count.toLocaleString('en-US')}\n`;
      const cols = t.columns.map((c) => `    ${c.name} ${c.type}`).join('\n');
      const sample = t.sample.length
        ? '  sample rows:\n' +
          t.sample.map((r) => '    ' + JSON.stringify(r)).join('\n')
        : '';
      // Harvest distinct low-cardinality values (e.g. type in {call,put}) straight
      // from the sample rows so the model knows legal enum members without a query.
      const distinct: string[] = [];
      for (const c of t.columns) {
        const vals = Array.from(
          new Set(t.sample.map((r) => r[c.name]).filter((v) => v != null)),
        );
        if (vals.length > 0 && vals.length <= 6) {
          distinct.push(`    ${c.name} in {${vals.map((v) => JSON.stringify(v)).join(', ')}}`);
        }
      }
      const distinctStr = distinct.length ? '\n  low-cardinality values:\n' + distinct.join('\n') : '';
      return `TABLE options.${t.name}\n  columns:\n${cols}${sample}${distinctStr}${size}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Deterministic schema validator
// ---------------------------------------------------------------------------
// Grounds model-written SQL against the *real* schema regardless of whether the
// model read the system prompt. Catches hallucinated tables/columns before the
// query runs and returns a precise, actionable error so the agent loop can fix
// it (autocorrect). Deliberately conservative: we only flag identifiers we can
// resolve with high confidence, never bare/ambiguous names — a false positive
// here would block otherwise-valid SQL, so we'd rather skip than misjudge.
interface ValidatedIssue {
  severity: 'error' | 'warning';
  message: string;
}

const SQL_ALIAS_KEYWORDS = new Set([
  'on', 'as', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'join',
  'where', 'using', 'select', 'from', 'group', 'by', 'having', 'order',
  'limit', 'qualify', 'with', 'and', 'or', 'not', 'case', 'when', 'then',
  'else', 'end', 'union', 'all', 'intersect', 'except', 'exists', 'in',
  'is', 'null', 'distinct', 'over', 'partition', 'rows', 'between', 'like',
]);

function validateSqlSchema(sql: string, ctx: SchemaContext): ValidatedIssue[] {
  const tables = ctx.tables.map((t) => t.name);
  const lowerTables = new Set(tables.map((t) => t.toLowerCase()));
  const columnsByTable = new Map<string, Set<string>>();
  for (const t of ctx.tables) {
    columnsByTable.set(t.name.toLowerCase(), new Set(t.columns.map((c) => c.name.toLowerCase())));
  }

  // Strip string literals ('...', '' escapes) so values can't be mistaken for
  // identifiers.
  let s = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (sql[i + 1] === "'") { i++; s += ' '; continue; }
      // toggle: inside a string literal we replace everything up to the close quote
      s += ' ';
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    s += ch;
  }

  // CTE names ('WITH name AS (') are not physical tables; collect them so we
  // don't flag them as unknown when referenced.
  const cteNames = new Set<string>();
  const cteRe = /([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi;
  let cm: RegExpExecArray | null;
  while ((cm = cteRe.exec(s))) cteNames.add(cm[1].toLowerCase());

  const issues: ValidatedIssue[] = [];
  const tableIssued = new Set<string>();

  // ---- table references (FROM / JOIN) ----
  const aliasToTable = new Map<string, string>();
  const refRe = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_.]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(s))) {
    const ref = m[1];
    const alias = m[2] && !SQL_ALIAS_KEYWORDS.has(m[2].toLowerCase()) ? m[2].toLowerCase() : null;
    const dot = ref.indexOf('.');
    const bare = dot === -1 ? ref : ref.slice(dot + 1);
    const ns = dot === -1 ? null : ref.slice(0, dot);
    const lb = bare.toLowerCase();

    if (cteNames.has(lb)) continue; // CTE, not a physical table
    if (lowerTables.has(lb)) {
      if (alias) aliasToTable.set(alias, lb);
      if (ns && ns.toLowerCase() !== 'options' && !tableIssued.has(lb)) {
        tableIssued.add(lb);
        issues.push({
          severity: 'error',
          message: `Unknown schema '${ns}'. Tables live in the 'options' schema (e.g. options.${bare}).`,
        });
      }
      continue;
    }
    if (tableIssued.has(lb)) continue;
    tableIssued.add(lb);
    if (ns) {
      issues.push({
        severity: 'error',
        message: `Unknown table '${ref}'. Available tables: ${tables.map((t) => `options.${t}`).join(', ')}. Fix the table name and try again.`,
      });
    } else {
      issues.push({
        severity: 'warning',
        message: `'${ref}' is not a known table and not a CTE. If it is a table, qualify it as options.${ref} (available tables: ${tables.map((t) => `options.${t}`).join(', ')}).`,
      });
    }
  }

  // ---- qualified column references (alias.col / table.col) ----
  // Only validate when we can resolve the qualifier; skip bare columns and
  // unresolvable aliases (subquery/CTE outputs) to avoid false positives.
  const colRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let cm2: RegExpExecArray | null;
  while ((cm2 = colRe.exec(s))) {
    const qual = cm2[1].toLowerCase();
    const col = cm2[2].toLowerCase();
    const tableName = aliasToTable.get(qual) ?? (lowerTables.has(qual) ? qual : null);
    if (!tableName) continue;
    const cols = columnsByTable.get(tableName);
    if (cols && !cols.has(col)) {
      issues.push({
        severity: 'warning',
        message: `Unknown column '${cm2[1]}.${cm2[2]}': table options.${tableName} has no column named '${cm2[2]}'. Columns: ${Array.from(cols).sort().join(', ')}.`,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Result summariser (compact text fed back to the model inside the tool)
// ---------------------------------------------------------------------------
function summarizeResult(res: QueryResult): string {
  const { columns, rows, row_count } = res;
  const lines: string[] = [`Columns: ${columns.join(', ')}`, `Row count: ${row_count}`];
  const shown = rows.slice(0, 30);
  if (shown.length > 0) {
    lines.push('---', 'Rows (pipe-separated):');
    for (const r of shown) {
      const vals = columns.map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'number') {
          return Number.isInteger(v) ? String(v) : v.toFixed(4);
        }
        if (typeof v === 'boolean') return String(v);
        const s = String(v);
        return s.length > 120 ? s.slice(0, 117) + '…' : s;
      });
      lines.push('  ' + vals.join(' | '));
    }
    if (rows.length > 30) lines.push(`  … (showing 30 of ${row_count} rows)`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Agent tool: run a read-only query via the Worker
// ---------------------------------------------------------------------------
// The `run_query` tool is what turns the generic chat() loop into an agent:
// the model proposes SQL, the tool executes it and returns a compact summary
// the model can reason over, and the loop repeats (fix on error) until the
// model answers. The full QueryResult is captured for the UI separately from
// what the model sees.
const runQueryDef = toolDefinition({
  name: 'run_query',
  description:
    'Execute ONE read-only DataFusion (R2 SQL) SELECT/WITH query against the ' +
    'CBOE options Iceberg lake and return a compact result summary. Tables live ' +
    'in the `options` schema. Use this to answer questions about the data. ' +
    'SQL is validated against the real schema before running.',
  inputSchema: z.object({
    sql: z.string().describe('A single read-only SQL query (SELECT or WITH).'),
  }),
  outputSchema: z.object({
    ok: z.boolean().describe('Whether the query ran without an error.'),
    error: z.string().nullable().describe('Error message, or null when ok.'),
    summary: z.string().describe('Compact result summary for reasoning.'),
  }),
});

const checkSchemaDef = toolDefinition({
  name: 'check_schema',
  description:
    'Deterministically validate a proposed SQL query against the real table and ' +
    'column names in the `options` schema — without executing it. Returns any ' +
    'unknown tables/columns so you can fix them before calling run_query.',
  inputSchema: z.object({
    sql: z.string().describe('The SQL query to validate against the schema.'),
  }),
  outputSchema: z.object({
    ok: z.boolean().describe('Whether the query references only known tables/columns.'),
    issues: z.array(z.string()).describe('Human-readable validation issues, if any.'),
  }),
});

// ---------------------------------------------------------------------------
// Agent tool: render a chart of the most recent query result in the chat UI
// ---------------------------------------------------------------------------
// The model fetches chartable data with run_query, then calls render_chart to
// request a chart. The frontend captures the spec (from the tool-call input)
// alongside the last query result and renders it — the tool itself is a no-op
// server-side; its only job is to appear in the agent loop so the model can
// declare a chart and keep producing the natural-language answer.
const renderChartDef = toolDefinition({
  name: 'render_chart',
  description:
    'Show the most recent run_query result as a chart in the chat. Call this AFTER a ' +
    'run_query that fetched the chart data, naming the EXACT result columns to plot: ' +
    '`x` (x-axis), `y` (y-axis), and optionally `series` to split into one line/bar per ' +
    'distinct value. For a volatility surface: x=strike, y=implied_vol, series=expiration ' +
    '(or a DTE column) → one curve per expiration. For a stock OI/IV profile: x=strike, ' +
    'y=(open_interest|implied_vol), series=type. Use `line` for curves/surfaces, `bar` for ' +
    'single-variable magnitude (e.g. OI by strike), `scatter` for point clouds.',
  inputSchema: z.object({
    title: z.string().optional().describe('Short chart heading.'),
    kind: z.enum(['line', 'area', 'scatter', 'bar']).default('line'),
    x: z.string().describe('Column in the most recent query result for the x-axis.'),
    y: z.string().describe('Column in the most recent query result for the y-axis.'),
    series: z.string().optional().describe('Optional column that splits data into one series per value.'),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean().describe('Whether the chart spec is well-formed.'),
    error: z.string().nullable().describe('Error message, or null when ok.'),
  }),
});

// ---------------------------------------------------------------------------
// TanStack AI agent: answer a question by writing + running SQL
// ---------------------------------------------------------------------------
interface AgentCapture {
  sql: string | null;
  result: QueryResult | null;
  chart: ChartSpec | null;
}

function systemPrompt(schemaPrompt: string): string {
  return [
    'You are a senior quant developer writing DataFusion SQL (R2 SQL) against an options market Iceberg lake.',
    '',
    'Schema:',
    schemaPrompt,
    '',
    'Rules:',
    '- To answer, ALWAYS write a read-only query (SELECT or WITH) and execute it with the run_query tool.',
    '- Use ONLY the table and column names in the Schema above. NEVER invent or guess identifiers — run_query validates your SQL against the real schema and will reject unknown tables/columns. If unsure, call check_schema on your SQL first.',
    '- Always end the top-level query with LIMIT (e.g. LIMIT 100). The backend caps rows anyway, but write your own LIMIT.',
    '- implied_vol is a decimal (0.25 = 25%). Moneyness ≈ (strike - spot) / spot.',
    '- The spot price column is `spot_price` (not `spot`). expiration is TEXT (use CAST(expiration AS DATE) for date math).',
    '- DTE: CAST(expiration AS DATE) - CURRENT_DATE returns integer days.',
    '- No OFFSET (unsupported). No named WINDOW clause (inline OVER (...) only).',
    '- WHERE must come before QUALIFY.',
    '- Prefer explicit column names over SELECT *.',
    '- The run_query tool returns a compact summary. If a query errors, fix it and call run_query again (a few attempts max).',
    '',
    'R2 SQL engine constraints (failures/timeouts here block your answer):',
    '- Read-only engine: only SELECT/WITH/DESCRIBE/SHOW/EXPLAIN are allowed; CROSS JOIN is rejected.',
    '- Expensive queries are budget-gated or time out: avoid joins of 3+ large tables with no WHERE filter, COUNT(DISTINCT x)/(DISTINCT) across joins or high-cardinality columns, ARRAY_AGG/STRING_AGG, and window functions over large partitions. Prefer WHERE filters + GROUP BY and the approx_* aggregates (approx_distinct, approx_median, approx_percentile_cont).',
    '- Filter before joining; join tables on keys (symbol, run_id) rather than scanning everything.',
    '',
    '- After you have the results, answer the user\'s question in plain English:',
    'mention specific symbols, sectors, and numbers where useful. If no rows were',
    'returned, say so and suggest a looser query. Be data-driven and conversational.',
    'Do NOT explain the SQL mechanics.',
    '',
    'Charting:',
    '- If the user asks for a chart (a stock chart, vol surface, IV smile/skew, OI/IV',
    '  profile, anything visual), you MUST call render_chart AFTER a run_query that',
    '  returned the chartable data — do not finish with just a table. There is no',
    '  historical price series in this lake, so "chart of a stock" means chart what IS',
    '  available for it: the IV smile (implied_vol vs strike), IV term structure, or',
    '  OI/IV profile by strike. SELECT the specific numeric columns you will chart.',
    '- Vol surface: x=strike, y=implied_vol, series=expiration.',
    '- IV smile: x=strike, y=implied_vol. OI/IV profile: x=strike, y=open_interest, series=type.',
    '- kind: `line` for curves/surfaces, `bar` for magnitudes, `scatter` for point clouds.',
    '- Give a short title and xLabel/yLabel when axis units help (yLabel="Implied vol"',
    '  for a 0-1 IV, xLabel="Strike"). Example: "Show the IV surface for AAPL" →',
    '  run_query for strike, implied_vol, expiration; then render_chart',
    '  { title: "AAPL IV surface", kind: "line", x: "strike", y: "implied_vol",',
    '    series: "expiration" }.',
  ].join('\n');
}

async function runAgent(
  question: string,
  apiKey: string,
  model: string,
  schema: SchemaContext,
  capture: AgentCapture,
  onStatus?: AskCallbacks['onStatus'],
): Promise<string> {
  const schemaPrompt = schemaToPrompt(schema);

  const checkSchema = checkSchemaDef.server(async ({ sql }) => {
    const issues = validateSqlSchema(sql, schema);
    return {
      ok: issues.length === 0,
      issues: issues.map((i) => `[${i.severity}] ${i.message}`),
    };
  });

  const runQuery = runQueryDef.server(async ({ sql }) => {
    // Deterministic grounding: pre-validate identifiers against the real schema
    // so hallucinated tables/columns are rejected with a precise message BEFORE
    // hitting the backend. The agent loop then autocorrects and retries.
    const issues = validateSqlSchema(sql, schema);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      const msg = errors.map((i) => i.message).join(' ');
      return { ok: false, error: msg, summary: `Schema validation failed: ${msg}` };
    }

    onStatus?.('Running query…');
    const res = await api.query(sql, 200);
    capture.sql = sql;
    capture.result = res;
    if (res.error) {
      return { ok: false, error: res.error, summary: `Query failed: ${res.error}` };
    }
    const warnings = issues
      .filter((i) => i.severity === 'warning')
      .map((i) => i.message)
      .join(' ');
    return {
      ok: true,
      error: null,
      summary: warnings ? `Schema notes: ${warnings}\n${summarizeResult(res)}` : summarizeResult(res),
    };
  });

  const renderChart = renderChartDef.server(async ({ x, y }) => {
    // The chart itself is rendered client-side from the captured tool input +
    // the last query result; this executor only needs to validate + let the
    // agent loop continue toward the natural-language answer.
    const result = capture.result;
    if (!result || result.error) {
      return { ok: false, error: 'No successful query result to chart. Call run_query first.' };
    }
    const cols = new Set(result.columns);
    if (!cols.has(x) || !cols.has(y)) {
      return {
        ok: false,
        error: `Result has no columns '${x}'/'${y}'. Available: ${result.columns.join(', ')}.`,
      };
    }
    return { ok: true, error: null };
  });

  const adapter = openaiCompatibleText(model, {
    baseURL: OPENROUTER_BASE,
    apiKey,
    // BYOK: the key is owned by the user, stored only in their browser, and
    // sent straight to OpenRouter — there is no server in this AI path that
    // could leak it. That is exactly the case `dangerouslyAllowBrowser` is for
    // (it disables the OpenAI SDK's default browser-key guard).
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      'HTTP-Referer': window.location.origin,
      'X-Title': APP_TITLE,
    },
  });

  const stream = chat({
    adapter,
    messages: [
      {
        id: 'user',
        role: 'user',
        parts: [{ type: 'text', content: question }],
      },
    ],
    // systemPrompt is threaded via the `systemPrompts` option, NOT a system
    // message: TanStack AI's message conversion deliberately drops role:'system'
    // UIMessages and ModelMessage has no 'system' role.
    systemPrompts: [systemPrompt(schemaPrompt)],
    tools: [runQuery, checkSchema, renderChart],
    agentLoopStrategy: maxIterations(8),
    modelOptions: {
      temperature: 0.2,
      // Only send reasoning_effort to models the catalog says support it —
      // OpenRouter rejects unsupported parameters.
      ...(modelSupports(model, 'reasoning_effort')
        ? { reasoning_effort: getEffort() }
        : {}),
    },
    stream: true,
  });

  // The final assistant text comes after the last tool call; drop any text the
  // model emitted before deciding to call a tool.
  let answer = '';
  for await (const ev of stream) {
    if (ev.type === 'TOOL_CALL_END') {
      // Capture a chart spec the model declared, paired with the last result,
      // so the UI can render it alongside the answer. Only keep text emitted
      // after the last tool call (the final answer).
      // Some adapters emit the tool name on `toolName` (deprecated) rather than
      // `toolCallName`, and `input` may arrive as a JSON string — accept any of
      // these so capture never silently drops a requested chart.
      let toolName: string | undefined = ev.toolCallName;
      if (toolName === undefined && 'toolName' in ev) {
        const tn = ev.toolName;
        if (typeof tn === 'string') toolName = tn;
      }
      if (toolName === 'render_chart') {
        let input: unknown = ev.input;
        if (typeof input === 'string') {
          try { input = JSON.parse(input); } catch { /* keep raw */ }
        }
        if (input && typeof input === 'object') {
          const c = input as Partial<ChartSpec>;
          if (typeof c.x === 'string' && typeof c.y === 'string') {
            capture.chart = { kind: c.kind ?? 'line', ...input } as ChartSpec;
          }
        }
      }
      answer = '';
    } else if (ev.type === 'TEXT_MESSAGE_CONTENT' && typeof ev.delta === 'string') {
      answer += ev.delta;
    } else if (ev.type === 'RUN_ERROR') {
      throw new Error(ev.message || 'The model request failed.');
    }
  }
  return answer.trim();
}

// ---------------------------------------------------------------------------
// Public pipeline: ask a question → get answer + SQL + result
// ---------------------------------------------------------------------------
export interface AskCallbacks {
  onStatus?: (status: string) => void;
}

export interface AskResult {
  answer: string;
  sql: string | null;
  result: QueryResult | null;
  /** Chart the model asked to render (paired with `result`), or null. */
  chart: ChartSpec | null;
}

export async function askAi(
  question: string,
  opts: AskCallbacks = {},
): Promise<AskResult> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No API key configured. Set it in the settings panel first.');

  const model = getModel();
  const capture: AgentCapture = { sql: null, result: null, chart: null };

  opts.onStatus?.('Reading schema…');
  let schema: SchemaContext;
  try {
    schema = await buildSchemaContext();
  } catch (e) {
    throw new Error(`Failed to read schema: ${e}`);
  }

  opts.onStatus?.('Reasoning over the data…');
  let answer: string;
  try {
    answer = await runAgent(question, apiKey, model, schema, capture, opts.onStatus);
  } catch (e) {
    // If the agent itself errored but a query already ran, still surface the
    // (partial) result rather than dropping it.
    if (capture.result) {
      answer = `The query ran but the model did not finish an answer: ${e}`;
    } else {
      throw e;
    }
  }

  return { answer, sql: capture.sql, result: capture.result, chart: capture.chart };
}
