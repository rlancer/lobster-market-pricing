/**
 * Admin-only marimo HTML snapshots stored in a private R2 bucket.
 *
 * The lake tape notebook needs Iceberg tokens, so we do not ship html-wasm
 * (Pyodide) to the browser. `marimo export html` runs on a trusted machine
 * and the Worker serves that snapshot behind requireBotAdmin. The bucket has
 * no public r2.dev / custom domain — this module is the only reader.
 */

export type AdminGate =
  | { ok: true }
  | { ok: false; status: 401; error: string };

export interface MarimoExportEnv {
  MARIMO_EXPORTS?: R2Bucket;
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

export async function loadMarimoMeta(
  bucket: R2Bucket,
  notebook: MarimoNotebookCatalog,
): Promise<{ exported_at: string | null; git_sha: string | null }> {
  const object = await bucket.get(notebook.metaKey);
  if (!object) return { exported_at: null, git_sha: null };
  try {
    const rec = asRecord(await object.json());
    return {
      exported_at: asStr(rec?.exported_at),
      git_sha: asStr(rec?.git_sha),
    };
  } catch {
    return { exported_at: null, git_sha: null };
  }
}

export async function listMarimoNotebooks(bucket: R2Bucket): Promise<MarimoNotebookView[]> {
  const items: MarimoNotebookView[] = [];
  for (const notebook of MARIMO_NOTEBOOKS) {
    const [head, meta] = await Promise.all([
      bucket.head(notebook.htmlKey),
      loadMarimoMeta(bucket, notebook),
    ]);
    items.push({
      ...notebook,
      present: Boolean(head),
      exported_at: meta.exported_at ?? (head?.uploaded ? head.uploaded.toISOString() : null),
      git_sha: meta.git_sha,
      bytes: head?.size ?? null,
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
  },
): Promise<Response | null> {
  if (path !== "/api/admin/marimo" && !path.startsWith("/api/admin/marimo/")) {
    return null;
  }

  const admin = await opts.requireAdmin(req);
  if (!admin.ok) return json({ error: admin.error }, admin.status);

  const bucket = env.MARIMO_EXPORTS;
  if (!bucket) {
    return json({ error: "marimo export bucket is not bound" }, 503);
  }

  if (path === "/api/admin/marimo") {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json({ items: await listMarimoNotebooks(bucket) }, 200);
  }

  const slug = decodeURIComponent(path.slice("/api/admin/marimo/".length)).replace(/\/+$/, "");
  const notebook = lookupMarimoNotebook(slug);
  if (!notebook) return json({ error: "unknown notebook" }, 404);
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const object = await bucket.get(notebook.htmlKey);
  if (!object) return json({ error: "snapshot not uploaded yet" }, 404);

  const meta = await loadMarimoMeta(bucket, notebook);
  const headers = new Headers({
    "Content-Type": object.httpMetadata?.contentType || "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `inline; filename="${notebook.slug}.html"`,
  });
  if (meta.exported_at) headers.set("X-Marimo-Exported-At", meta.exported_at);
  if (meta.git_sha) headers.set("X-Marimo-Git-Sha", meta.git_sha);
  headers.set("X-Marimo-Source", notebook.source);

  return new Response(object.body, { status: 200, headers });
}
