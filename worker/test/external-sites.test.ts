import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cikFromEdgarUrl,
  etfIssuerMarketingSite,
  normalizeCompanyWebsite,
  researchExternalSites,
  secCompanyBrowseUrl,
} from "../src/external-sites";

describe("etfIssuerMarketingSite", () => {
  it("maps known families", () => {
    const v = etfIssuerMarketingSite("Vanguard");
    assert.ok(v);
    assert.equal(v!.kind, "issuer");
    assert.match(v!.url, /vanguard/);
  });

  it("maps State Street / SPDR", () => {
    const s = etfIssuerMarketingSite("State Street Investment Management");
    assert.ok(s);
    assert.match(s!.url, /ssga/);
  });

  it("returns null for unknown families", () => {
    assert.equal(etfIssuerMarketingSite("Unknown Boutique"), null);
    assert.equal(etfIssuerMarketingSite(""), null);
  });
});

describe("sec + edgar helpers", () => {
  it("extracts CIK from archives URLs", () => {
    assert.equal(
      cikFromEdgarUrl("https://www.sec.gov/Archives/edgar/data/320193/0000320193-24-000001/"),
      "0000320193",
    );
  });

  it("builds company browse URLs", () => {
    assert.equal(
      secCompanyBrowseUrl("320193"),
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&owner=exclude&count=40",
    );
  });
});

describe("normalizeCompanyWebsite", () => {
  it("adds https and strips trailing slash", () => {
    assert.equal(normalizeCompanyWebsite("www.apple.com/"), "https://www.apple.com");
  });

  it("rejects junk", () => {
    assert.equal(normalizeCompanyWebsite("not a url"), null);
    assert.equal(normalizeCompanyWebsite(""), null);
  });
});

describe("researchExternalSites", () => {
  it("prefers company website for equities", () => {
    const links = researchExternalSites({
      ticker: "AAPL",
      isEtf: false,
      companyWebsite: "https://www.apple.com",
    });
    assert.equal(links[0]?.kind, "company");
  });

  it("falls back to company profile for equities without a homepage", () => {
    const links = researchExternalSites({
      ticker: "AAPL",
      isEtf: false,
    });
    assert.ok(links.some((l) => l.kind === "yahoo_profile"));
    assert.equal(links.find((l) => l.kind === "yahoo_profile")?.label, "Company profile");
  });

  it("adds issuer for ETFs", () => {
    const links = researchExternalSites({
      ticker: "SPY",
      isEtf: true,
      etfFamily: "State Street Investment Management",
    });
    assert.ok(links.some((l) => l.kind === "issuer"));
  });
});
