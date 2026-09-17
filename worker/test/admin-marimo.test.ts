import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  handleAdminMarimo,
  listMarimoNotebooks,
  lookupMarimoNotebook,
  MARIMO_NOTEBOOKS,
  marimoObjectUrl,
} from "../src/admin-marimo.ts";

const HTML = "<!doctype html><html><body>tape</body></html>";
const META = JSON.stringify({
  exported_at: "2026-09-17T01:02:03.000Z",
  git_sha: "abc1234",
  source: "notebooks/apps/lake_tape_backtest.py",
  bytes: HTML.length,
});

const ENV = {
  R2_SQL_ACCOUNT_ID: "acct123",
  R2_DATA_CATALOG_TOKEN: "catalog-token",
};

function fetchMap(objects: Record<string, { status: number; body: string; contentType?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(objects).find(([key]) => url.endsWith(`/objects/${key}`));
    if (!hit) return new Response("missing", { status: 404 });
    const [, object] = hit;
    return new Response(object.body, {
      status: object.status,
      headers: { "Content-Type": object.contentType ?? "application/octet-stream" },
    });
  }) as typeof fetch;
}

function snapshotFetch(): typeof fetch {
  const notebook = MARIMO_NOTEBOOKS[0];
  assert.ok(notebook);
  return fetchMap({
    [notebook.htmlKey]: { status: 200, body: HTML, contentType: "text/html; charset=utf-8" },
    [notebook.metaKey]: { status: 200, body: META, contentType: "application/json" },
  });
}

const allowAdmin = async () => ({ ok: true as const });
const denyAdmin = async () => ({ ok: false as const, status: 401 as const, error: "unauthorized" });

describe("lookupMarimoNotebook", () => {
  it("resolves the lake tape snapshot and rejects junk slugs", () => {
    assert.equal(lookupMarimoNotebook("lake-tape-backtest")?.htmlKey, "marimo/lake-tape-backtest.html");
    assert.equal(lookupMarimoNotebook("nope"), null);
    assert.equal(lookupMarimoNotebook("../lake-tape-backtest"), null);
    assert.equal(lookupMarimoNotebook(""), null);
  });
});

describe("marimoObjectUrl", () => {
  it("keeps object key slashes so R2 can find nested keys", () => {
    assert.equal(
      marimoObjectUrl("acct123", "marimo/lake-tape-backtest.html"),
      "https://api.cloudflare.com/client/v4/accounts/acct123/r2/buckets/lobster-marimo-exports/objects/marimo/lake-tape-backtest.html",
    );
  });
});

describe("listMarimoNotebooks", () => {
  it("marks missing snapshots and fills metadata when present", async () => {
    const empty = await listMarimoNotebooks(ENV, fetchMap({}));
    assert.equal(empty.length, 1);
    assert.equal(empty[0]?.present, false);
    assert.equal(empty[0]?.bytes, null);

    const listed = await listMarimoNotebooks(ENV, snapshotFetch());
    assert.equal(listed[0]?.present, true);
    assert.equal(listed[0]?.git_sha, "abc1234");
    assert.equal(listed[0]?.exported_at, "2026-09-17T01:02:03.000Z");
    assert.equal(listed[0]?.bytes, HTML.length);
  });
});

describe("handleAdminMarimo", () => {
  it("ignores unrelated paths", async () => {
    const res = await handleAdminMarimo(ENV, new Request("https://api.lobster.mp/api/admin/users"), "/api/admin/users", {
      requireAdmin: allowAdmin,
      fetchImpl: snapshotFetch(),
    });
    assert.equal(res, null);
  });

  it("requires an admin session", async () => {
    const res = await handleAdminMarimo(
      ENV,
      new Request("https://api.lobster.mp/api/admin/marimo"),
      "/api/admin/marimo",
      { requireAdmin: denyAdmin, fetchImpl: snapshotFetch() },
    );
    assert.ok(res);
    assert.equal(res.status, 401);
  });

  it("503s when the catalog token is missing", async () => {
    const res = await handleAdminMarimo(
      { R2_SQL_ACCOUNT_ID: "acct123" },
      new Request("https://api.lobster.mp/api/admin/marimo"),
      "/api/admin/marimo",
      { requireAdmin: allowAdmin, fetchImpl: snapshotFetch() },
    );
    assert.ok(res);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /not configured/);
  });

  it("lists catalog rows", async () => {
    const res = await handleAdminMarimo(
      ENV,
      new Request("https://api.lobster.mp/api/admin/marimo"),
      "/api/admin/marimo",
      { requireAdmin: allowAdmin, fetchImpl: snapshotFetch() },
    );
    assert.ok(res);
    assert.equal(res.status, 200);
    const body = await res.json() as { items: Array<{ slug: string; present: boolean }> };
    assert.equal(body.items[0]?.slug, "lake-tape-backtest");
    assert.equal(body.items[0]?.present, true);
  });

  it("serves the HTML snapshot", async () => {
    const res = await handleAdminMarimo(
      ENV,
      new Request("https://api.lobster.mp/api/admin/marimo/lake-tape-backtest"),
      "/api/admin/marimo/lake-tape-backtest",
      { requireAdmin: allowAdmin, fetchImpl: snapshotFetch() },
    );
    assert.ok(res);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("x-marimo-git-sha"), "abc1234");
    assert.equal(await res.text(), HTML);
  });

  it("sends the catalog token as Bearer on R2 REST reads", async () => {
    const auths: string[] = [];
    const inner = snapshotFetch();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      auths.push(new Headers(init?.headers).get("authorization") ?? "");
      return inner(input, init);
    }) as typeof fetch;
    const res = await handleAdminMarimo(
      ENV,
      new Request("https://api.lobster.mp/api/admin/marimo/lake-tape-backtest"),
      "/api/admin/marimo/lake-tape-backtest",
      { requireAdmin: allowAdmin, fetchImpl },
    );
    assert.ok(res);
    assert.equal(res.status, 200);
    assert.ok(auths.length >= 1);
    assert.ok(auths.every((value) => value === "Bearer catalog-token"));
  });

  it("502s when R2 REST fails", async () => {
    const res = await handleAdminMarimo(
      ENV,
      new Request("https://api.lobster.mp/api/admin/marimo/lake-tape-backtest"),
      "/api/admin/marimo/lake-tape-backtest",
      {
        requireAdmin: allowAdmin,
        fetchImpl: fetchMap({
          "marimo/lake-tape-backtest.html": { status: 500, body: "nope" },
        }),
      },
    );
    assert.ok(res);
    assert.equal(res.status, 502);
  });

  it("404s when the snapshot is not uploaded", async () => {
    const res = await handleAdminMarimo(
      ENV,
      new Request("https://api.lobster.mp/api/admin/marimo/lake-tape-backtest"),
      "/api/admin/marimo/lake-tape-backtest",
      { requireAdmin: allowAdmin, fetchImpl: fetchMap({}) },
    );
    assert.ok(res);
    assert.equal(res.status, 404);
  });
});
