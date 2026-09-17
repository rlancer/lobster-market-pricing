/**
 * Admin-only marimo HTML snapshots stored in a private R2 bucket.
 *
 * The lake tape notebook needs Iceberg tokens, so we do not ship html-wasm
 * (Pyodide) to the browser. `marimo export html` runs on a trusted machine
 * and this module serves that snapshot behind requireBotAdmin.
 *
 * The GitHub Workers deploy token cannot bind R2 buckets, so there is no
 * `r2_buckets` entry in wrangler.jsonc. Reads go through the Cloudflare R2
 * REST API with `R2_DATA_CATALOG_TOKEN` (R2 Storage Admin). The bucket has
 * no r2.dev public access and no CORS.
 */

export type AdminGate =
  | { ok: true }
  | { ok: false; status: 401; error: string };

export interface MarimoExportEnv {
  R2_SQL_ACCOUNT_ID: string;
  R2_DATA_CATALOG_TOKEN?: string;
}

export interface MarimoNotebookCatalog {
  slug: string;
  title: string;
  description: string;
  source: string;
  htmlKey: string;
  metaKey: string;
}

export interface MarimoNotebookView extends MarimoNotebookCatalog {
  present: boolean;
  exported_at: string | null;
  git_sha: string | null;
  bytes: number | null;
}

export const MARIMO_BUCKET = "lobster-marimo-exports";

export const MARIMO_NOTEBOOKS: readonly MarimoNotebookCatalog[] = [
  {
    slug: "lake-tape-backtest",
    title: "Kalshi sports tape backtest",
    description:
      "Iceberg-only listed two-leg sports universe, RFQ book scores, and the Sep 15 BUY NO fill cohort. Static snapshot — not a live CLOB and not wasm.",
    source: "notebooks/apps/lake_tape_backtest.py",
    htmlKey: "marimo/lake-tape-backtest.html",
    metaKey: "marimo/lake-tape-backtest.json",
  },
];

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function lookupMarimoNotebook(slug: string): MarimoNotebookCatalog | null {
  const trimmed = slug.trim();
  if (!SLUG_RE.test(trimmed) || trimmed.length > 64) return null;
  return MARIMO_NOTEBOOKS.find((item) => item.slug === trimmed) ?? null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStr(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function marimoObjectUrl(accountId: string, key: string): string {
  return (
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/r2/buckets/${encodeURIComponent(MARIMO_BUCKET)}/objects/${key}`
  );
}

async function r2Get(
  env: MarimoExportEnv,
  key: string,
  fetchImpl: typeof fetch,
): Promise<Response | null> {
  const token = (env.R2_DATA_CATALOG_TOKEN ?? "").trim();
  const account = (env.R2_SQL_ACCOUNT_ID ?? "").trim();
  if (!token || !account) {
    throw new Error("marimo R2 credentials are not configured");
  }
  const res = await fetchImpl(marimoObjectUrl(account, key), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET ${res.status}`);
  return res;
}

export async function loadMarimoMeta(
  env: MarimoExportEnv,
  notebook: MarimoNotebookCatalog,
  fetchImpl: typeof fetch,
): Promise<{ exported_at: string | null; git_sha: string | null; bytes: number | null }> {
  const object = await r2Get(env, notebook.metaKey, fetchImpl);
  if (!object) return { exported_at: null, git_sha: null, bytes: null };
  try {
    const rec = asRecord(await object.json());
    const bytes = typeof rec?.bytes === "number" && Number.isFinite(rec.bytes) ? rec.bytes : null;
    return {
      exported_at: asStr(rec?.exported_at),
      git_sha: asStr(rec?.git_sha),
      bytes,
    };
  } catch {
    return { exported_at: null, git_sha: null, bytes: null };
  }
}

export async function listMarimoNotebooks(
  env: MarimoExportEnv,
  fetchImpl: typeof fetch,
): Promise<MarimoNotebookView[]> {
  const items: MarimoNotebookView[] = [];
  for (const notebook of MARIMO_NOTEBOOKS) {
    const meta = await loadMarimoMeta(env, notebook, fetchImpl);
    items.push({
      ...notebook,
      present: Boolean(meta.exported_at || meta.bytes),
      exported_at: meta.exported_at,
      git_sha: meta.git_sha,
      bytes: meta.bytes,
    });
  }
  return items;
}

export async function handleAdminMarimo(
  env: MarimoExportEnv,
  req: Request,
  path: string,
  opts: {
    requireAdmin: (req: Request) => Promise<AdminGate>;
    fetchImpl?: typeof fetch;
  },
): Promise<Response | null> {
  if (path !== "/api/admin/marimo" && !path.startsWith("/api/admin/marimo/")) {
    return null;
  }

  const admin = await opts.requireAdmin(req);
  if (!admin.ok) return json({ error: admin.error }, admin.status);

  const token = (env.R2_DATA_CATALOG_TOKEN ?? "").trim();
  const account = (env.R2_SQL_ACCOUNT_ID ?? "").trim();
  if (!token || !account) {
    return json({ error: "marimo export store is not configured" }, 503);
  }

  const fetchImpl = opts.fetchImpl ?? fetch;

  try {
    if (path === "/api/admin/marimo") {
      if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
      return json({ items: await listMarimoNotebooks(env, fetchImpl) }, 200);
    }

    const slug = decodeURIComponent(path.slice("/api/admin/marimo/".length)).replace(/\/+$/, "");
    const notebook = lookupMarimoNotebook(slug);
    if (!notebook) return json({ error: "unknown notebook" }, 404);
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

    const [object, meta] = await Promise.all([
      r2Get(env, notebook.htmlKey, fetchImpl),
      loadMarimoMeta(env, notebook, fetchImpl),
    ]);
    if (!object) return json({ error: "snapshot not uploaded yet" }, 404);

    const headers = new Headers({
      "Content-Type": object.headers.get("content-type") || "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${notebook.slug}.html"`,
    });
    if (meta.exported_at) headers.set("X-Marimo-Exported-At", meta.exported_at);
    if (meta.git_sha) headers.set("X-Marimo-Git-Sha", meta.git_sha);
    headers.set("X-Marimo-Source", notebook.source);

    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 502);
  }
}
