import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  handleAdminMarimo,
  listMarimoNotebooks,
  lookupMarimoNotebook,
  MARIMO_NOTEBOOKS,
} from "../src/admin-marimo.ts";

class MemoryObject {
  readonly uploaded = new Date("2026-09-17T01:02:03.000Z");
  readonly httpMetadata = { contentType: "text/html; charset=utf-8" };
  readonly size: number;
  constructor(
    readonly key: string,
    private readonly payload: string,
  ) {
    this.size = new TextEncoder().encode(payload).byteLength;
  }
  get body(): ReadableStream<Uint8Array> {
    return new Blob([this.payload]).stream();
  }
  async text(): Promise<string> {
    return this.payload;
  }
  async json(): Promise<unknown> {
    return JSON.parse(this.payload);
  }
}

class MemoryBucket {
  constructor(private readonly objects: Map<string, MemoryObject>) {}
  async head(key: string): Promise<MemoryObject | null> {
    return this.objects.get(key) ?? null;
  }
  async get(key: string): Promise<MemoryObject | null> {
    return this.objects.get(key) ?? null;
  }
}

const HTML = "<!doctype html><html><body>tape</body></html>";
const META = JSON.stringify({
  exported_at: "2026-09-17T01:02:03.000Z",
  git_sha: "abc1234",
  source: "notebooks/apps/lake_tape_backtest.py",
});

function bucketWithSnapshot(): MemoryBucket {
  const notebook = MARIMO_NOTEBOOKS[0];
  assert.ok(notebook);
  return new MemoryBucket(new Map([
    [notebook.htmlKey, new MemoryObject(notebook.htmlKey, HTML)],
    [notebook.metaKey, new MemoryObject(notebook.metaKey, META)],
  ]));
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

describe("listMarimoNotebooks", () => {
  it("marks missing snapshots and fills metadata when present", async () => {
    const empty = await listMarimoNotebooks(new MemoryBucket(new Map()) as unknown as R2Bucket);
    assert.equal(empty.length, 1);
    assert.equal(empty[0]?.present, false);
    assert.equal(empty[0]?.bytes, null);

    const listed = await listMarimoNotebooks(bucketWithSnapshot() as unknown as R2Bucket);
    assert.equal(listed[0]?.present, true);
    assert.equal(listed[0]?.git_sha, "abc1234");
    assert.equal(listed[0]?.exported_at, "2026-09-17T01:02:03.000Z");
    assert.ok((listed[0]?.bytes ?? 0) > 0);
  });
});

describe("handleAdminMarimo", () => {
  it("ignores unrelated paths", async () => {
    const res = await handleAdminMarimo({}, new Request("https://api.lobster.mp/api/admin/users"), "/api/admin/users", {
      requireAdmin: allowAdmin,
    });
    assert.equal(res, null);
  });

  it("requires an admin session", async () => {
    const res = await handleAdminMarimo(
      { MARIMO_EXPORTS: bucketWithSnapshot() as unknown as R2Bucket },
      new Request("https://api.lobster.mp/api/admin/marimo"),
      "/api/admin/marimo",
      { requireAdmin: denyAdmin },
    );
    assert.ok(res);
    assert.equal(res.status, 401);
  });

  it("503s when the bucket binding is missing", async () => {
    const res = await handleAdminMarimo({}, new Request("https://api.lobster.mp/api/admin/marimo"), "/api/admin/marimo", {
      requireAdmin: allowAdmin,
    });
    assert.ok(res);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /not bound/);
  });

  it("lists catalog rows", async () => {
    const res = await handleAdminMarimo(
      { MARIMO_EXPORTS: bucketWithSnapshot() as unknown as R2Bucket },
      new Request("https://api.lobster.mp/api/admin/marimo"),
      "/api/admin/marimo",
      { requireAdmin: allowAdmin },
    );
    assert.ok(res);
    assert.equal(res.status, 200);
    const body = await res.json() as { items: Array<{ slug: string; present: boolean }> };
    assert.equal(body.items[0]?.slug, "lake-tape-backtest");
    assert.equal(body.items[0]?.present, true);
  });

  it("serves the HTML snapshot", async () => {
    const res = await handleAdminMarimo(
      { MARIMO_EXPORTS: bucketWithSnapshot() as unknown as R2Bucket },
      new Request("https://api.lobster.mp/api/admin/marimo/lake-tape-backtest"),
      "/api/admin/marimo/lake-tape-backtest",
      { requireAdmin: allowAdmin },
    );
    assert.ok(res);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("x-marimo-git-sha"), "abc1234");
    assert.equal(await res.text(), HTML);
  });

  it("404s when the snapshot is not uploaded", async () => {
    const res = await handleAdminMarimo(
      { MARIMO_EXPORTS: new MemoryBucket(new Map()) as unknown as R2Bucket },
      new Request("https://api.lobster.mp/api/admin/marimo/lake-tape-backtest"),
      "/api/admin/marimo/lake-tape-backtest",
      { requireAdmin: allowAdmin },
    );
    assert.ok(res);
    assert.equal(res.status, 404);
  });
});
