# Marimo notebooks (WASM)

Prototype notebooks that run in the browser via [marimo islands](https://docs.marimo.io/guides/exporting/webassembly_html/#embed-marimo-outputs-in-html-using-islands)
(Pyodide WASM + CDN runtime). They talk to the existing screener Worker over
`/api/*` — no Python on the Worker.

| Source | Served at | UI |
| --- | --- | --- |
| `lake_sectors.py` | `/notebooks/lake-sectors/` | `/notebook` (iframe) |

## Edit / regenerate

```bash
# optional: marimo edit notebooks/lake_sectors.py
./notebooks/export-islands.sh
```

That rewrites `frontend/public/notebooks/lake-sectors/index.html` (~10 KB; the
heavy Pyodide/marimo bits load from jsDelivr at runtime).

## Full self-hosted html-wasm (optional)

If you want the fat offline bundle + Cloudflare Worker scaffold instead of the
CDN islands page:

```bash
marimo export html-wasm notebooks/lake_sectors.py \
  -o /tmp/lake-sectors-wasm --mode run --include-cloudflare -f
```

See [Publish to Cloudflare](https://docs.marimo.io/guides/publishing/cloudflare/).
