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

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const APP_TITLE = 'Open Interest Options Workspace';

// ---------------------------------------------------------------------------
// Credential / model helpers (localStorage)
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'openinterest_ai_key';
const MODEL_KEY = 'openinterest_ai_model';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

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
// TanStack AI agent: answer a question by writing + running SQL
// ---------------------------------------------------------------------------
interface AgentCapture {
  sql: string | null;
  result: QueryResult | null;
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
    'After you have the results, answer the user\'s question in plain English:',
    'mention specific symbols, sectors, and numbers where useful. If no rows were',
    'returned, say so and suggest a looser query. Be data-driven and conversational.',
    'Do NOT explain the SQL mechanics.',
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
    tools: [runQuery, checkSchema],
    agentLoopStrategy: maxIterations(8),
    modelOptions: { temperature: 0.2 },
    stream: true,
  });

  // The final assistant text comes after the last tool call; drop any text the
  // model emitted before deciding to call a tool.
  let answer = '';
  for await (const ev of stream) {
    if (ev.type === 'TOOL_CALL_END') {
      // Only keep text emitted after the last tool call (the final answer).
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
}

export async function askAi(
  question: string,
  opts: AskCallbacks = {},
): Promise<AskResult> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No API key configured. Set it in the settings panel first.');

  const model = getModel();
  const capture: AgentCapture = { sql: null, result: null };

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

  return { answer, sql: capture.sql, result: capture.result };
}
