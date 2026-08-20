// SEC EDGAR filings enrichment for the options lake.
//
// Fetches company submissions from data.sec.gov, filters to the form types we
// care about (equity 10-K/10-Q/8-K + ETF prospectus family), and publishes
// metadata rows to `options.sec_filings` via Cloudflare Pipelines. Documents
// stay on EDGAR — we store the stable filing URL so research can link out.
// The lake is append-only; consumers latest-wins on `accession`.

import { securityIdForTicker } from "./symbology.js";

export const SEC_SOURCE = "edgar";

/** Equity periodic / current reports. */
export const EQUITY_FORM_TYPES = new Set([
  "10-K",
  "10-K/A",
  "10-Q",
  "10-Q/A",
  "8-K",
  "8-K/A",
]);

/** ETF / open-end fund prospectus and registration family. */
export const PROSPECTUS_FORM_TYPES = new Set([
  "N-1A",
  "N-1A/A",
  "485BPOS",
  "485APOS",
  "485BXT",
  "497",
  "497K",
]);

export const SEC_FILING_FIELDS = [
  "ticker",
  "security_id",
  "cik",
  "form_type",
  "accession",
  "filed_at",
  "report_date",
  "primary_document",
  "description",
  "edgar_url",
  "kind",
  "source",
  "run_id",
  "fetched_at",
] as const;

export const DEFAULT_SEC_TICKERS_URL =
  "https://www.sec.gov/files/company_tickers.json";
export const DEFAULT_SEC_SUBMISSIONS_TEMPLATE =
  "https://data.sec.gov/submissions/CIK{cik}.json";

// SEC fair-access policy requires a descriptive User-Agent with a contact.
export const DEFAULT_SEC_USER_AGENT =
  "LobsterMarketPricing/0.1 (research; contact: rob@lobster.mp)";

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 30;
/** Soft cap per symbol per pass so a first sync does not flood the stream. */
export const DEFAULT_MAX_FILINGS_PER_SYMBOL = 40;

export type SecFilingKind = "filing" | "prospectus";

export interface SecEnv {
  SEC_TICKERS_URL?: string;
  SEC_SUBMISSIONS_TEMPLATE?: string;
  SEC_USER_AGENT?: string;
  PIPELINE_SEC_FILINGS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  SEC_MAX_FILINGS_PER_SYMBOL?: number;
  now?: () => Date;
  runId?: () => string;
  /** Injected ticker→CIK map (skips company_tickers fetch in tests). */
  cikByTicker?: Map<string, string>;
}

export interface SecFilingRow {
  ticker: string;
  security_id: string;
  cik: string;
  form_type: string;
  accession: string;
  filed_at: string;
  report_date: string | null;
  primary_document: string | null;
  description: string | null;
  edgar_url: string;
  kind: SecFilingKind;
  source: string;
  run_id: string;
  fetched_at: string;
}

export interface SecPublishResult {
  ticker: string;
  cik: string | null;
  row_count: number;
  published: boolean;
  run_id: string;
  fetched_at: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function num(v: number | undefined, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function stripNones(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNones);
  const rec = asRecord(value);
  if (rec) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      const v = rec[key];
      if (v !== null && v !== undefined) out[key] = v;
    }
    return out;
  }
  return value;
}

function backoffSeconds(env: SecEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

/** Pad CIK to the 10-digit zero-padded form used by data.sec.gov paths. */
export function padCik(cik: string | number): string {
  const digits = String(cik).replace(/\D/g, "");
  return digits.padStart(10, "0");
}

/** Accession with dashes → no-dashes folder name under Archives/edgar/data. */
export function accessionFolder(accession: string): string {
  return accession.replace(/-/g, "");
}

export function filingKindForForm(formType: string, isEtf: boolean): SecFilingKind | null {
  const form = formType.trim().toUpperCase();
  if (isEtf && PROSPECTUS_FORM_TYPES.has(form)) return "prospectus";
  if (!isEtf && EQUITY_FORM_TYPES.has(form)) return "filing";
  // ETFs sometimes also file 8-K (e.g. trust events) — keep those as filings.
  if (isEtf && EQUITY_FORM_TYPES.has(form)) return "filing";
  return null;
}

export function edgarDocumentUrl(
  cik: string,
  accession: string,
  primaryDocument: string | null | undefined,
): string {
  const cikNum = String(Number(padCik(cik))); // unpadded path segment
  const folder = accessionFolder(accession);
  const doc = (primaryDocument || "").trim();
  if (doc) {
    return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${folder}/${doc}`;
  }
  // Index page when the primary document is missing.
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${folder}/`;
}

function project(row: SecFilingRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of SEC_FILING_FIELDS) out[f] = row[f];
  return out;
}

/**
 * Parse SEC company_tickers.json into ticker → zero-padded CIK.
 * Payload shape: { "0": { cik_str, ticker, title }, "1": … }.
 */
export function parseCompanyTickers(payload: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const rec = asRecord(payload);
  if (!rec) return map;
  for (const value of Object.values(rec)) {
    const row = asRecord(value);
    if (!row) continue;
    const ticker = strip(row.ticker).toUpperCase();
    const cik = strip(row.cik_str) || String(row.cik_str ?? row.cik ?? "");
    if (!ticker || !cik) continue;
    map.set(ticker, padCik(cik));
  }
  return map;
}

interface RecentFilings {
  accessionNumber?: unknown;
  filingDate?: unknown;
  reportDate?: unknown;
  form?: unknown;
  primaryDocument?: unknown;
  primaryDocDescription?: unknown;
}

/**
 * Walk submissions.filings.recent parallel arrays into SecFilingRow[].
 * `isEtf` selects prospectus vs equity form filters (ETFs also keep 8-K/10-*).
 */
export function parseSubmissionsFilings(
  payload: unknown,
  ticker: string,
  opts: {
    isEtf: boolean;
    runId: string;
    fetchedAt: string;
    maxFilings?: number;
    cikOverride?: string;
  },
): SecFilingRow[] {
  const root = asRecord(payload);
  if (!root) return [];
  const cik = padCik(opts.cikOverride || strip(root.cik) || "0");
  const filings = asRecord(root.filings);
  const recent = asRecord(filings?.recent) as RecentFilings | null;
  if (!recent) return [];

  const accessions = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
  const filingDates = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const reportDates = Array.isArray(recent.reportDate) ? recent.reportDate : [];
  const forms = Array.isArray(recent.form) ? recent.form : [];
  const primaryDocs = Array.isArray(recent.primaryDocument) ? recent.primaryDocument : [];
  const descriptions = Array.isArray(recent.primaryDocDescription)
    ? recent.primaryDocDescription
    : [];

  const securityId = securityIdForTicker(ticker);
  const max = opts.maxFilings ?? DEFAULT_MAX_FILINGS_PER_SYMBOL;
  const out: SecFilingRow[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < accessions.length; i++) {
    const formType = strip(forms[i]).toUpperCase();
    const kind = filingKindForForm(formType, opts.isEtf);
    if (!kind) continue;
    const accession = strip(accessions[i]);
    if (!accession || seen.has(accession)) continue;
    seen.add(accession);
    const primaryDocument = strip(primaryDocs[i]) || null;
    const filedAt = strip(filingDates[i]);
    if (!filedAt) continue;
    out.push({
      ticker: ticker.toUpperCase(),
      security_id: securityId,
      cik,
      form_type: formType,
      accession,
      filed_at: filedAt,
      report_date: strip(reportDates[i]) || null,
      primary_document: primaryDocument,
      description: strip(descriptions[i]) || null,
      edgar_url: edgarDocumentUrl(cik, accession, primaryDocument),
      kind,
      source: SEC_SOURCE,
      run_id: opts.runId,
      fetched_at: opts.fetchedAt,
    });
    if (out.length >= max) break;
  }
  return out;
}

async function secGet(url: string, env: SecEnv): Promise<unknown> {
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const timeoutMs = Math.floor(num(env.REQUEST_TIMEOUT, REQUEST_TIMEOUT_SECONDS_DEFAULT) * 1000);
  const ua = env.SEC_USER_AGENT || DEFAULT_SEC_USER_AGENT;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let controller: AbortController | null = null;
    try {
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          headers: {
            "user-agent": ua,
            accept: "application/json",
            "accept-encoding": "gzip, deflate",
          },
          signal: controller.signal,
        });
        if (response.ok) return await response.json();
        const code = response.status;
        const detail = await response.text();
        lastError = new Error(`sec returned HTTP ${code}: ${detail.slice(0, 160)}`);
        // 429 / 5xx retry; hard-fail other 4xx.
        if (code === 429 || code >= 500) {
          if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      else break;
    }
  }
  throw new Error(`sec fetch failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

export async function loadCikMap(env: SecEnv = {}): Promise<Map<string, string>> {
  if (env.cikByTicker) return env.cikByTicker;
  const url = env.SEC_TICKERS_URL || DEFAULT_SEC_TICKERS_URL;
  const payload = await secGet(url, env);
  return parseCompanyTickers(payload);
}

export async function fetchSubmissions(cik: string, env: SecEnv = {}): Promise<unknown> {
  const template = env.SEC_SUBMISSIONS_TEMPLATE || DEFAULT_SEC_SUBMISSIONS_TEMPLATE;
  const url = template.replace("{cik}", padCik(cik));
  return secGet(url, env);
}

async function requestJson(
  url: string,
  payload: unknown,
  idempotencyKey: string,
  authToken: string,
  env: SecEnv,
): Promise<void> {
  if (!url) return;
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const body = JSON.stringify(stripNones(payload));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "cboe-to-r2/0.2",
  };
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
    headers["idempotency-key"] = idempotencyKey;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body });
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(backoffSeconds(env, attempt) * 1000);
        continue;
      }
      break;
    }
    if (response.ok) return;
    const code = response.status;
    const detail = await response.text();
    lastError = new Error(`pipeline returned HTTP ${code}: ${detail}`);
    if (code < 500) throw lastError;
    if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
  }
  throw new Error(
    `pipeline request failed after ${retries + 1} attempts: ${errMsg(lastError)}`,
  );
}

/**
 * Resolve CIK → fetch submissions → filter → publish one ticker's filings.
 * Returns row_count=0 / published=false when the ticker has no CIK mapping
 * (foreign listings, crypto spot, etc.) without throwing.
 */
export async function publishSecFilings(
  ticker: string,
  env: SecEnv,
  opts: { isEtf: boolean; cikMap: Map<string, string> },
): Promise<SecPublishResult> {
  const url = env.PIPELINE_SEC_FILINGS_URL || "";
  if (!url) {
    throw new Error("sec filings publish requires PIPELINE_SEC_FILINGS_URL");
  }
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = (env.now ? env.now() : new Date()).toISOString();
  const sym = ticker.toUpperCase();
  const cik = opts.cikMap.get(sym) ?? null;
  if (!cik) {
    return { ticker: sym, cik: null, row_count: 0, published: false, run_id: runId, fetched_at: fetchedAt };
  }

  const payload = await fetchSubmissions(cik, env);
  const max = Math.floor(num(env.SEC_MAX_FILINGS_PER_SYMBOL, DEFAULT_MAX_FILINGS_PER_SYMBOL));
  const rows = parseSubmissionsFilings(payload, sym, {
    isEtf: opts.isEtf,
    runId,
    fetchedAt,
    maxFilings: max,
    cikOverride: cik,
  });
  if (rows.length === 0) {
    return { ticker: sym, cik, row_count: 0, published: false, run_id: runId, fetched_at: fetchedAt };
  }

  await requestJson(
    url,
    rows.map(project),
    `sec-filings:${runId}:${sym}`,
    env.PIPELINE_AUTH_TOKEN || "",
    env,
  );
  return {
    ticker: sym,
    cik,
    row_count: rows.length,
    published: true,
    run_id: runId,
    fetched_at: fetchedAt,
  };
}
