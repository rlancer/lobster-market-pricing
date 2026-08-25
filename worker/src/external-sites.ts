/**
 * External destination URLs for research entities — company / issuer marketing
 * sites and Kalshi series pages. Pure helpers (no I/O) so the research brief
 * and idle link endpoint share one map without lake schema changes.
 */

/** Issuer marketing / product-home URLs keyed by Yahoo fundProfile.family. */
const ETF_ISSUER_SITES: Array<{ match: RegExp; label: string; url: string }> = [
  { match: /^ishares\b|blackrock/i, label: "iShares", url: "https://www.ishares.com/us" },
  { match: /^vanguard\b/i, label: "Vanguard", url: "https://investor.vanguard.com/investment-products/etfs" },
  {
    match: /^state street\b|^spdr\b|ssga/i,
    label: "SPDR / State Street",
    url: "https://www.ssga.com/us/en/intermediary/etfs",
  },
  { match: /^invesco\b/i, label: "Invesco", url: "https://www.invesco.com/us/en/financial-products/etfs.html" },
  { match: /^proshares\b/i, label: "ProShares", url: "https://www.proshares.com/" },
  { match: /^van\s*eck\b|^vaneck\b/i, label: "VanEck", url: "https://www.vaneck.com/us/en/etf/" },
  { match: /^direxion\b/i, label: "Direxion", url: "https://www.direxion.com/" },
  { match: /^global\s*x\b/i, label: "Global X", url: "https://www.globalxetfs.com/" },
  { match: /^ark\b/i, label: "ARK", url: "https://ark-funds.com/" },
  { match: /^fidelity\b/i, label: "Fidelity", url: "https://www.fidelity.com/etfs/overview" },
  { match: /^schwab\b|charles schwab/i, label: "Schwab", url: "https://www.schwab.com/etfs" },
  { match: /^first trust\b/i, label: "First Trust", url: "https://www.ftportfolios.com/" },
  { match: /^wisdomtree\b/i, label: "WisdomTree", url: "https://www.wisdomtree.com/" },
  { match: /^jp\s*morgan\b|^jpmorgan\b/i, label: "J.P. Morgan", url: "https://am.jpmorgan.com/us/en/asset-management/liq/products/etfs" },
  { match: /^pimco\b/i, label: "PIMCO", url: "https://www.pimco.com/en-us/investments/etfs" },
  { match: /^amplify\b/i, label: "Amplify", url: "https://amplifyetfs.com/" },
  { match: /^roundhill\b/i, label: "Roundhill", url: "https://www.roundhillinvestments.com/" },
  { match: /^bitwise\b/i, label: "Bitwise", url: "https://bitwiseinvestments.com/" },
  { match: /^grayscale\b/i, label: "Grayscale", url: "https://www.grayscale.com/" },
];

export interface ExternalSiteLink {
  kind: "issuer" | "company" | "sec" | "kalshi" | "yahoo_profile";
  label: string;
  url: string;
}

/** Map Yahoo ETF family → issuer marketing site. */
export function etfIssuerMarketingSite(
  family: string | null | undefined,
): ExternalSiteLink | null {
  const name = String(family || "").trim();
  if (!name) return null;
  for (const row of ETF_ISSUER_SITES) {
    if (row.match.test(name)) {
      return { kind: "issuer", label: `${row.label} ETFs`, url: row.url };
    }
  }
  return null;
}

/** SEC company browse page when we have a CIK. */
export function secCompanyBrowseUrl(cik: string | null | undefined): string | null {
  const digits = String(cik || "").replace(/\D/g, "");
  if (!digits || !/^\d{1,10}$/.test(digits)) return null;
  const padded = digits.padStart(10, "0");
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${padded}&owner=exclude&count=40`;
}

/** Pull CIK from an EDGAR archives URL when filings carry one. */
export function cikFromEdgarUrl(edgarUrl: string | null | undefined): string | null {
  const m = String(edgarUrl || "").match(/\/data\/(\d+)\//);
  if (!m?.[1]) return null;
  return m[1].padStart(10, "0");
}

/** Yahoo quote profile (useful when we lack a direct company website). */
export function yahooQuoteProfileUrl(ticker: string | null | undefined): string | null {
  const t = String(ticker || "").trim().toUpperCase();
  if (!t || !/^[A-Z^][A-Z0-9.=-]{0,15}$/.test(t)) return null;
  return `https://finance.yahoo.com/quote/${encodeURIComponent(t)}/profile`;
}

/**
 * Normalize a company homepage from Yahoo assetProfile.website.
 * Rejects non-http(s) and obvious junk.
 */
export function normalizeCompanyWebsite(raw: string | null | undefined): string | null {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Build the static (no live fetch) external link set for a research brief. */
export function researchExternalSites(opts: {
  ticker: string;
  isEtf: boolean;
  etfFamily?: string | null;
  edgarUrl?: string | null;
  companyWebsite?: string | null;
}): ExternalSiteLink[] {
  const links: ExternalSiteLink[] = [];
  const company = normalizeCompanyWebsite(opts.companyWebsite);
  if (company) {
    links.push({ kind: "company", label: "Company site", url: company });
  }
  if (opts.isEtf) {
    const issuer = etfIssuerMarketingSite(opts.etfFamily);
    if (issuer) links.push(issuer);
  }
  const cik = cikFromEdgarUrl(opts.edgarUrl);
  const sec = secCompanyBrowseUrl(cik);
  if (sec) {
    links.push({ kind: "sec", label: "SEC filings", url: sec });
  }
  if (!company && !opts.isEtf) {
    const yahoo = yahooQuoteProfileUrl(opts.ticker);
    if (yahoo) links.push({ kind: "yahoo_profile", label: "Company profile", url: yahoo });
  }
  return links;
}
