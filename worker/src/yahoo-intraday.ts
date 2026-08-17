// On-demand Yahoo chart intraday bars for the research Day chart.
// Same v8 chart source as the loader's daily OHLC path; 5-minute bars for
// range=1d. Not lake-backed — session bars change throughout the day and are
// short-lived; the Worker caches the HTTP response briefly.

export const DEFAULT_INTRADAY_URL_TEMPLATE =
  "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1d&interval=5m";

export const YAHOO_UA = "cboe-to-r2/0.2";
export const INTRADAY_TIMEOUT_MS = 12_000;
export const INTRADAY_RETRIES = 2;

export interface IntradayBar {
  /** Exchange-local wall time as YYYY-MM-DDTHH:MM (for chart x-axis). */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function yahooChartSymbol(symbol: string): string {
  return symbol.replace(/\./g, "-");
}

/** Format epoch seconds + gmtoffset as exchange-local YYYY-MM-DDTHH:MM. */
export function isoDateTime(tsSec: number, offsetSec: number): string {
  const d = new Date((tsSec + offsetSec) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

export function buildIntradayUrl(
  symbol: string,
  template = DEFAULT_INTRADAY_URL_TEMPLATE,
): string {
  return template.replace("{symbol}", encodeURIComponent(yahooChartSymbol(symbol)));
}

/**
 * Parse a Yahoo v8 chart payload into ascending 5m bars.
 * Drops buckets with no close (pre/post gaps Yahoo sometimes emits as null).
 */
export function parseYahooIntraday(payload: unknown, symbol: string): IntradayBar[] {
  const chart = asRecord(payload)?.chart as unknown;
  const result = asRecord(chart)?.result as unknown;
  const first = Array.isArray(result) ? asRecord(result[0]) : null;
  if (!first) throw new Error(`yahoo intraday for ${symbol}: no result`);

  const meta = asRecord(first.meta);
  const offsetSec = typeof meta?.gmtoffset === "number" ? meta.gmtoffset : 0;
  const timestamps = Array.isArray(first.timestamp) ? first.timestamp : [];

  const indicators = asRecord(first.indicators);
  const quote = indicators?.quote ?? undefined;
  const q0 = asRecord(Array.isArray(quote) ? quote[0] : null);

  const toNum = (arr: unknown, i: number): number | null => {
    const v = Array.isArray(arr) ? arr[i] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  const bars: IntradayBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    const close = toNum(q0?.close, i);
    if (close == null) continue;
    bars.push({
      date: isoDateTime(ts, offsetSec),
      open: toNum(q0?.open, i),
      high: toNum(q0?.high, i),
      low: toNum(q0?.low, i),
      close,
      volume: toNum(q0?.volume, i),
    });
  }
  return bars;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchYahooIntraday(
  symbol: string,
  opts?: {
    urlTemplate?: string;
    fetchImpl?: typeof fetch;
    retries?: number;
    timeoutMs?: number;
  },
): Promise<IntradayBar[]> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const retries = opts?.retries ?? INTRADAY_RETRIES;
  const timeoutMs = opts?.timeoutMs ?? INTRADAY_TIMEOUT_MS;
  const url = buildIntradayUrl(symbol, opts?.urlTemplate);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { "user-agent": YAHOO_UA },
        signal: controller.signal,
      });
      if (response.ok) {
        const payload = await response.json();
        const bars = parseYahooIntraday(payload, symbol);
        if (bars.length === 0) {
          throw new Error(`yahoo intraday for ${symbol}: no bars`);
        }
        return bars;
      }
      const code = response.status;
      lastError = new Error(`yahoo intraday returned HTTP ${code}`);
      if (code !== 408 && code !== 429 && code < 500) throw lastError;
      if (attempt < retries) await sleep(250 * (attempt + 1));
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(250 * (attempt + 1));
      else break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `yahoo intraday failed after ${retries + 1} attempts: ${errMsg(lastError)}`,
  );
}
