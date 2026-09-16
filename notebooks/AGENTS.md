# Research notebooks (marimo)

Local-only uv project. The product API does not use this DuckDB file.

## Run

From the repo root (mise provides Python 3.12 and uv):

```bash
mise install
mise run notebooks-sync
mise run notebooks
```

`mise run notebooks` loads the gitignored root `.env` (Kalshi + R2 catalog tokens)
and starts marimo with `--no-token` so [marimo-pair](https://github.com/marimo-team/marimo-pair)
can attach. Open the notebook UI; the kernel is the source of truth.

Do **not** edit `apps/*.py` from the IDE while a session is running — use
`marimo._code_mode` from the pair scratchpad. Do **not** print secret values.
Do **not** `CREATE`/`INSERT`/`DELETE` on the attached `lake.*` catalog.

## Layout

- `src/lobster_nb/` — env, Iceberg attach, Kalshi RSA-PSS helpers
- `apps/` — marimo notebooks only (so `marimo edit apps` does not open library modules)
- `.cache/kalshi.duckdb` — local HF cache + lake attach state (gitignored)

SQL cells should use the `conn` engine from `lobster_nb.lake.connect`.
