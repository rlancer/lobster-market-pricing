/**
 * ETF issuer marketing URLs — frontend mirror of worker/src/external-sites.ts
 * for research-page link chrome without an extra round-trip.
 */

export interface ExternalSiteLink {
  kind: 'issuer' | 'company' | 'sec' | 'kalshi' | 'yahoo_profile';
  label: string;
  url: string;
}

const ETF_ISSUER_SITES: Array<{ match: RegExp; label: string; url: string }> = [
  { match: /^ishares\b|blackrock/i, label: 'iShares', url: 'https://www.ishares.com/us' },
  { match: /^vanguard\b/i, label: 'Vanguard', url: 'https://investor.vanguard.com/investment-products/etfs' },
  {
    match: /^state street\b|^spdr\b|ssga/i,
    label: 'SPDR / State Street',
    url: 'https://www.ssga.com/us/en/intermediary/etfs',
  },
  { match: /^invesco\b/i, label: 'Invesco', url: 'https://www.invesco.com/us/en/financial-products/etfs.html' },
  { match: /^proshares\b/i, label: 'ProShares', url: 'https://www.proshares.com/' },
  { match: /^van\s*eck\b|^vaneck\b/i, label: 'VanEck', url: 'https://www.vaneck.com/us/en/etf/' },
  { match: /^direxion\b/i, label: 'Direxion', url: 'https://www.direxion.com/' },
  { match: /^global\s*x\b/i, label: 'Global X', url: 'https://www.globalxetfs.com/' },
  { match: /^ark\b/i, label: 'ARK', url: 'https://ark-funds.com/' },
  { match: /^fidelity\b/i, label: 'Fidelity', url: 'https://www.fidelity.com/etfs/overview' },
  { match: /^schwab\b|charles schwab/i, label: 'Schwab', url: 'https://www.schwab.com/etfs' },
  { match: /^first trust\b/i, label: 'First Trust', url: 'https://www.ftportfolios.com/' },
  { match: /^wisdomtree\b/i, label: 'WisdomTree', url: 'https://www.wisdomtree.com/' },
  { match: /^jp\s*morgan\b|^jpmorgan\b/i, label: 'J.P. Morgan', url: 'https://am.jpmorgan.com/us/en/asset-management/liq/products/etfs' },
  { match: /^pimco\b/i, label: 'PIMCO', url: 'https://www.pimco.com/en-us/investments/etfs' },
  { match: /^amplify\b/i, label: 'Amplify', url: 'https://amplifyetfs.com/' },
  { match: /^roundhill\b/i, label: 'Roundhill', url: 'https://www.roundhillinvestments.com/' },
  { match: /^bitwise\b/i, label: 'Bitwise', url: 'https://bitwiseinvestments.com/' },
  { match: /^grayscale\b/i, label: 'Grayscale', url: 'https://www.grayscale.com/' },
];

export function etfIssuerMarketingSite(
  family: string | null | undefined,
): ExternalSiteLink | null {
  const name = String(family || '').trim();
  if (!name) return null;
  for (const row of ETF_ISSUER_SITES) {
    if (row.match.test(name)) {
      return { kind: 'issuer', label: `${row.label} ETFs`, url: row.url };
    }
  }
  return null;
}

export function cikFromEdgarUrl(edgarUrl: string | null | undefined): string | null {
  const m = String(edgarUrl || '').match(/\/data\/(\d+)\//);
  if (!m?.[1]) return null;
  return m[1].padStart(10, '0');
}

export function secCompanyBrowseUrl(cik: string | null | undefined): string | null {
  const digits = String(cik || '').replace(/\D/g, '');
  if (!digits || !/^\d{1,10}$/.test(digits)) return null;
  const padded = digits.padStart(10, '0');
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${padded}&owner=exclude&count=40`;
}
