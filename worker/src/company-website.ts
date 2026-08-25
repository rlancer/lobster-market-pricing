/**
 * Live Yahoo assetProfile.website lookup for equity research external links.
 * Idle / warm path only — not on GET /api/research first paint.
 */

import { normalizeCompanyWebsite } from "./external-sites";

const COOKIE_URL = "https://fc.yahoo.com";
const CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";
const QUOTE_SUMMARY_TEMPLATE =
  "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}" +
  "?modules=assetProfile&crumb={crumb}";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function yahooSymbol(ticker: string): string {
  return ticker.trim().toUpperCase();
}

async function openYahooSession(
  fetchImpl: typeof fetch,
): Promise<{ cookie: string; crumb: string }> {
  const cookieRes = await fetchImpl(COOKIE_URL, {
    headers: { "User-Agent": DEFAULT_UA },
    redirect: "manual",
  });
  const setCookie = cookieRes.headers.getSetCookie?.() ?? [];
  const cookie =
    setCookie.map((c) => c.split(";")[0]).filter(Boolean).join("; ")
    || String(cookieRes.headers.get("set-cookie") || "")
      .split(",")
      .map((c) => c.split(";")[0]?.trim())
      .filter(Boolean)
      .join("; ");
  if (!cookie) throw new Error("yahoo cookie missing");
  const crumbRes = await fetchImpl(CRUMB_URL, {
    headers: { "User-Agent": DEFAULT_UA, Cookie: cookie },
  });
  if (!crumbRes.ok) throw new Error(`yahoo crumb HTTP ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.length > 80) {
    throw new Error(`yahoo crumb invalid: ${crumb.slice(0, 40)}`);
  }
  return { cookie, crumb };
}

/**
 * Fetch company homepage from Yahoo assetProfile. Returns null on any failure.
 */
export async function fetchCompanyWebsite(
  ticker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const sym = yahooSymbol(ticker);
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(sym)) return null;
  try {
    const session = await openYahooSession(fetchImpl);
    const url = QUOTE_SUMMARY_TEMPLATE
      .replace("{symbol}", encodeURIComponent(sym))
      .replace("{crumb}", encodeURIComponent(session.crumb));
    const res = await fetchImpl(url, {
      headers: { "User-Agent": DEFAULT_UA, Cookie: session.cookie },
    });
    if (!res.ok) return null;
    const body = asRecord(await res.json());
    const qs = asRecord(body?.quoteSummary);
    const result = Array.isArray(qs?.result) ? asRecord(qs.result[0]) : null;
    const profile = asRecord(result?.assetProfile);
    const website = typeof profile?.website === "string" ? profile.website : null;
    return normalizeCompanyWebsite(website);
  } catch {
    return null;
  }
}
