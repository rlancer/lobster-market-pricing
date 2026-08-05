# CBOE Data Pipeline + GitHub Actions ETL (Plan)

**Status:** proposed (not yet implemented)
**Date:** 2026-08-05
**Owner:** screener_glm52

## TL;DR

Switch the options data source from Yahoo Finance (`yfinance`) to the **CBOE delayed
quotes API** (official exchange data, includes Greeks, one call per symbol) and automate
the ETL → Parquet → R2 refresh with a **GitHub Actions cron workflow**, so the dataset
keeps updating without a server or a machine left on.

**This is a hard cutover: the app has no users.** We rip out the Yahoo path and
`yfinance`/`greeks.py` entirely and commit fully to CBOE + DuckDB. No dual-source
migration, no A/B parity harness, no keeping old code around. We can also change the
schema freely (add `theo`, `bid_size`, `ask_size`) because the only consumer is our own
frontend, which we update in the same change.

> **Why GitHub Actions (and not Cloudflare Workers / local cron)?**
> - Avoids the original concern: requesting from a Cloudflare public IP risks tighter
>   throttling. GitHub Actions runs from GitHub's own IP range.
> - We accepted Actions are not ideal (free-tier runner limits, scheduled-run reliability,
>   eventual breakage) — this is explicitly a stopgap. The plan isolates the CBOE fetch
>   module so a later move to a Cloudflare Worker (TS) is cheap.
> - Workers have hard constraints for this job anyway: 128/256 MB memory (full scan is
>   ~500 MB raw JSON), ~15-min cron wall-clock, and awkward Parquet writing (DuckDB-WASM
>   vs hand-rolled writer). Not worth it yet.

## Research summary (why CBOE)

Live-tested `https://cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json`:

| | Yahoo (`yfinance`) | CBOE delayed quotes |
|---|---|---|
| Calls per symbol | 1 per expiration + loop | **1 total** (all exps in one response) |
| Options per symbol (AAPL) | 2,817 (22 exps) | **3,618 (24 exps)** |
| Greeks in payload | ❌ (computed locally) | ✅ **included** |
| IV | ✅ | ✅ + `iv30` per underlying |
| Spot | ✅ | ✅ `current_price` in same call |
| Rate limiting | ~5 req/s, 429s | **None observed** (10 rapid calls, all 200 @ ~0.5s) |
| Full S&P 500 | ~100s+ with sleep | **~4.3 min, 503 calls, ~500 MB raw JSON** |
| Delayed | ~15 min | ~15 min (fine for a screener) |
| Symbol format | `BRK-B` | `BRK.B` (uppercase, dots) |

CBOE per-record shape (all we need is present):

```json
{"option":"AAPL260805C00205000","bid":102.6,"ask":106.45,"iv":3.564,
 "open_interest":9.0,"volume":9.0,"delta":1.0,"gamma":0.0,
 "vega":0.0,"theta":0.0,"rho":0.0056,"theo":104.287,
 "last_trade_price":104.76,"last_trade_time":"2026-08-04T15:47:49","tick":"down"}
```

Response envelope: `{timestamp, symbol, data:{symbol, security_type, current_price,
bid, ask, open, high, low, close, prev_day_close, volume, iv30, ..., options:[...]}}`

The `option` string is OCC-standard: `ROOT yymmdd C/P pennies*1000`, e.g.
`AAPL 260805 C 00205000` → strike 205.000. Decode it to get `expiration` / `type` /
`strike`.

## Goal / scope (hard cutover)

- **Replace** `download.py` with `backend/screener/download_cboe.py`; delete the Yahoo
  path (`yfinance`), `download.py`, `greeks.py`, and the `--fresh`/resume machinery for
  Yahoo. CBOE is one call per symbol with greeks included — the old resume/backfill
  plumbing is dead weight.
- Extend the schema (no users → free to change): add `theo`, `bid_size`, `ask_size`.
- Update the DuckDB file, `export_parquet.py`, `mise.toml` tasks, frontend (`api.ts`,
  `db.ts`) in the same change so the whole stack reflects CBOE data + new columns.
- New `refresh-data.yml` GitHub Actions workflow: cron-scheduled, does download → export
  → upload to R2.
- **Do NOT keep a Yahoo fallback.** The cutover is all-or-nothing.

## Architecture

```
GitHub Actions (cron, nightly after market close)
  │  checkout repo
  │  uv sync (backend deps)
  │
  ├─ mise run download-cboe          # fetch 503 symbols → DuckDB (normalize P/E records)
  ├─ mise run export-parquet         # DuckDB → data/parquet/*.parquet + manifest.json
  └─ mise run upload-r2              # wrangler r2 object put --remote → R2 bucket
                                     # (same command as today; uses CLOUDFLARE_* secrets)
```

## Work breakdown

### 1. CBOE downloader — `backend/screener/download_cboe.py` (replaces `download.py`)

**Isolated fetch module (must stay portable):** a single function that takes a symbol
list and returns normalized rows, with **no** DuckDB/Parquet coupling, so it can later be
ported to a TS Worker with minimal work.

- `fetch_symbol(symbol) -> list[dict]` — one HTTP GET, decode OCC symbols, normalize to
  the `option_contracts` row shape. Handle `BRK.B`-style dots (keep Wikipedia `symbol`
  as-is, do NOT convert `.`→`-`).
- `fetch_all(symbols)` — loop with small default sleep (e.g. 0.25s) + retry/backoff on
  5xx / transient errors; log per-symbol success/failure.
- Uses stdlib `urllib` (or `requests`, already a dep) — **no `yfinance`, no pandas**
  (drop both from deps).
- Symbol handling: accept dotted (`BRK.B`) and plain (`AAPL`).

**Data mapping (keep existing column names in `option_contracts`):**

| CBOE field | derived from | → column |
|---|---|---|
| `option` OCC string | parse | `symbol` (root), `expiration` (DATE), `type` (C/P→call/put), `strike` (/1000) |
| `bid` / `ask` | → | `bid`, `ask` |
| `volume` / `open_interest` | → | `volume`, `open_interest` |
| `iv` | /100 (percent→decimal, CBOE reports 0.14 usually already decimal) | `implied_vol` (verify scale at impl) |
| `delta, gamma, theta, vega, rho` | → | same-named columns (no `greeks.py` needed) |
| `last_trade_price` | → | `last` |
| `data.current_price` | → | `underlyings.spot` |
| — | → | `fetched_at` = now |
| `in_the_money` | compute: call: strike<spot, put: strike>spot | `in_the_money` |
| `theo` | → | `theo` (new column) |
| `bid_size` / `ask_size` | → | `bid_size` / `ask_size` (new columns) |

Extend `db.py` schema with `theo DOUBLE`, `bid_size BIGINT`, `ask_size BIGINT`. Because
this is a hard cutover (no users) we can add the columns and update the frontend types
(`api.ts` / `db.ts`) in the same change — no frozen-schema constraint.

**Note on field scale to verify at implementation time:**
- CBOE `iv` may be reported as a decimal (0.146) or percent (3.564 in one sample — that's
  likely AAPL's day-1 IV mislabeled as IV; check a normalized near-ATM option). Existing
  code expects `implied_vol` as annualized decimal (e.g. 0.32). Confirm and normalize.
- `delta/gamma/theta/vega/rho` appear already in Black-Scholes units — copy as-is; sanity
  check against a manual Black-Scholes calc on a couple near-ATM rows (not a parity
  harness, just a spot-check).
- `theo` (theoretical price), `bid_size`, `ask_size` are persisted as new columns.

### 2. Remove the Yahoo pipeline + `greeks.py`

- Delete `download.py`, `greeks.py`, the `--fresh`/resume logic, and the `yfinance`/
  `pandas` deps from `pyproject.toml`.
- CBOE supplies greeks, so the Black-Scholes backfill (`greeks.py`) and its `mise run
  greeks` task go away. (Keep `greeks.py` math only if we ever need a live-recompute
  fallback — not for v1.)

### 3. S&P 500 list — `sp500.py`

- Wikipedia list stays the same. **Remove the `.`→`-` conversion** because CBOE wants
  `BRK.B`, not `BRK-B`. Handle mapping inside the downloader (keep `sp500.py` generic,
  return raw dotted symbols).

### 4. mise tasks — `mise.toml`

Add tasks so the workflow is thin:

```toml
[tasks.download-cboe]
description = "Download S&P 500 option chains from CBOE into DuckDB (replaces Yahoo path). Extra args appended, e.g. --limit 25"
run = "cd backend && uv run python -m screener.download_cboe"

[tasks.refresh]
description = "One-shot ETL: download-cboe → export-parquet → upload-r2"
run = "mise run download-cboe && mise run export-parquet && mise run upload-r2"
```

### 5. GitHub Actions — `.github/workflows/refresh-data.yml`

New file (alongside existing `deploy.yml`), **does not touch the deploy workflow**.

```yaml
name: Refresh options data

on:
  schedule:
    # Nightly after US market close, UTC. Adjust to avoid peak.
    - cron: "0 1 * * 1-5"     # 01:00 UTC Mon–Fri
  workflow_dispatch:          # manual trigger for testing

jobs:
  refresh:
    runs-on: ubuntu-latest
    concurrency:
      group: data-refresh
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }

      - name: Install tools (mise)
        run: |
          curl -LsSf https://mise.run | sh
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"
          mise install

      - name: Install Python deps
        run: mise run sync     # or: cd backend && uv sync

      - name: CBOE download
        run: mise run download-cboe

      - name: Export Parquet
        run: mise run export-parquet

      - name: Upload to R2
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: "r2 object put ..."   # mirror mise run upload-r2

      - name: Notify on failure
        if: failure()
        run: echo "::error::Data refresh failed"
```

Notes / decisions to finalize in a PR review:
- **IP / throttling:** runs on GitHub-hosted runners (Azure IP range). If CBOE ever
  throttles those, add a small `--sleep` (defaults 0.25s → 503 calls ≈ 2–3 min) — ample
  headroom; no observed throttling in testing.
- **Runner minutes:** full run ≈ 5–10 min. Free tier (2,000 min/mo) covers ~20 refreshes
  even at 15 min each — fine at nightly cadence.
- **Failure policy:** on failure, keep the last good Parquet in R2 (do NOT overwrite with
  partial data). Implement by exporting to a temp dir and only uploading on success, or
  uploading a `manifest.json` pointing at last-good version after a successful full export.
  Simplest v1: if any download step fails, `set -e` stops before R2 upload. Consider a
  `last-success` manifest later.
- **`wrangler-action` CLI compatibility:** `mise run upload-r2` uses `wrangler r2 object
  put`. The workflow can call `mise run upload-r2` directly instead of re-declaring the
  command, since the secrets are already in the Actions environment — decide in impl.

### 6. Frontend (same change — no users, so refresh everything together)

- Update `frontend/src/api.ts` / `db.ts` types to include `theo`, `bid_size`, `ask_size`
  and any renamed columns.
- Confirm the screener SQL / UI still works against the new Parquet (DuckDB-WASM).

### 7. Docs

- Update `README.md` data-source section (Yahoo → CBOE) and add the new `mise` tasks.
- Remove references to `yfinance` / `greeks.py`.
- Add a short `plans/`-adjacent note on the known Actions flakiness + the escape hatch
  (see Future work).

## Testing plan

1. **Local smoke:** `mise run download-cboe -- --limit 5` → verify DuckDB row counts, expiry
   span, greeks non-NULL on near-ATM rows, and the new `theo`/`bid_size`/`ask_size` columns.
2. **Full local:** `mise run download-cboe` → contract count (expect ~500–550k). Run
   `export-parquet` + `upload-r2`, sanity-check a known symbol's delta/gamma on the live R2
   URL via DuckDB-WASM.
3. **CI dispatch:** `workflow_dispatch` on `refresh-data.yml` → confirm all three steps run
   and R2 manifest `generated_at` updates.
4. **Frontend:** after upload, load the Pages site, confirm the screener reads the new
   Parquet and any new columns render (no freeze on old Yahoo schema).

Because this is a hard cutover, testing is end-to-end on the new stack only — no A/B
comparison against Yahoo.

## Risks / open questions

- **IV / greeks scale** — must verify CBOE's units vs what the UI expects (see note in
  section 1). Verify against a manual Black-Scholes spot-check before shipping (no Yahoo
  baseline to compare against after cutover).
- **CBOE data completeness per symbol** — some thinly-traded names may have sparse chains;
  eyeball bottom-N for sanity.
- **Cloudflare-IP throttling** — deferred (we run on GitHub). Keep the fetch module
  isolated so a Worker migration stays viable.
- **GitHub Actions reliability** — accepted stopgap. Scheduled runners can be delayed or
  flaky; backstop with a manual `workflow_dispatch` and (later) a Worker cron.
- **No rollback path** — with Yahoo removed, a broken CBOE fetch means no data. Mitigate by
  keeping the last-good Parquet in R2 (don't overwrite on partial failure) and using
  `workflow_dispatch` to re-run. Reintroducing Yahoo later is possible but was a deliberate
  trade-off for a clean cutover.

## Future work (escape hatches, documented here so this plan stays portable)

- **Move to Cloudflare Worker (TS):** port only `fetch_symbol` → a Worker that fetches
  CBOE symbol-by-symbol and writes each result to R2 incrementally (streaming, under 128 MB
  by never holding all 500 MB in memory; ~15-min cron wall-clock is ~3–4x headroom). No
  local DuckDB; would need a Parquet writer or store JSON-per-symbol + convert offline.
  This is the reason the fetch module stays isolated today.
- **Data volume:** full CBOE ~500–550k contracts + new `theo`/`bid_size`/`ask_size` columns
  → Parquet likely ~30 MB (vs 18.7 MB today). Still trivial for DuckDB-WASM; monitor
  download/upload time.

---

## Implementation status & handoff (updated 2026-08-05)

**State:** WIP, in a draft PR. The code cutover is mostly written but **not finished /
verified end-to-end**, and the local dataset is inconsistent.

### Done (in working tree / this PR)
- `backend/screener/download_cboe.py` — new CBOE downloader with an isolated fetch layer
  (`parse_occ`, `normalize_option`, `fetch_symbol`, `fetch_all`) + DuckDB `run()` driver.
- `backend/screener/db.py` — added `theo`, `bid_size`, `ask_size` to `option_contracts`.
- `backend/screener/sp500.py` — rewritten with `lxml` (no pandas); keeps dotted symbols.
- `backend/pyproject.toml` — dropped `yfinance`, `pandas` (excluded from `uv.lock`).
- Deleted `download.py`, `greeks.py`.
- `mise.toml` — `download-cboe` + `refresh` tasks; removed `download`/`greeks`.
- `.github/workflows/refresh-data.yml` — new nightly cron + `workflow_dispatch` ETL.
- `frontend/src/api.ts` — added optional `theo`/`bid_size`/`ask_size` types.
- Docs: `README.md`, `DEPLOYMENT-CLOUDFLARE.md` updated.

### Verified (live)
- IV is already an annualized decimal (0.34 = 34%) for normal rows → copied verbatim (do **not** `/100`).
- Dotted symbols work: `BRK.B`, `BF.B`; CBOE envelope keeps dots but OCC roots are dot-less
  (`BRKB`), so **`option_contracts.symbol` must be the requested/dotted symbol**, not the
  parsed OCC root, or the `underlyings` join breaks.
- `fetch_symbol` + `export_parquet` + frontend `npm run build` all pass.

### Findings that changed the plan
- **CBOE throttles (429)** on a ~503-symbol full run at 0.25s sleep (~symbol #484).
  Fix already applied: default `--sleep` bumped to **0.5s**, and 429/5xx are now **retried
  with backoff** (CboeRetryableError) while 404/other 4xx fail fast (CboeSymbolError).
- `run()` should exit **non-zero** if any symbol failed so CI stops before exporting/uploads
  partial data (already implemented via `run()` returning error count → `sys.exit`).
- **`run()` write phase is too slow / fragile** — it holds all results in memory then does a
  per-symbol `DELETE`+`INSERT` (503 transactions). A full run was killed mid-write leaving
  the DB inconsistent. **Refactor to a single batched write** (build one big list of rows;
  one `executemany` for all contracts, one for underlyings, one for the log) — faster and
  atomic-enough for a full-snapshot refresh.

### Current broken/partial state
- `data/options.duckdb` is **inconsistent**: 503 underlyings but only 52,634 contracts and
  39 `download_log` rows (write phase killed by `timeout`). **Must be fully re-downloaded.**
- R2 + `data/parquet/` still hold the old Yahoo-schema files (they still work; the new
  columns just aren't there until a CBOE refresh runs).

### Remaining work (the fresh-session task)
1. Refactor `download_cboe.run()` → batched single-transaction writes (see Finding above).
2. Full clean re-download (`mise run download-cboe`) → expect ~500–550k contracts, 503
   underlyings, `download_log` = 503 rows, 0 errors. Near-ATM greeks non-null.
3. `mise run export-parquet` → verify Parquet has `theo`/`bid_size`/`ask_size`.
4. Upload to R2 (`mise run upload-r2`; `CLOUDFLARE_API_TOKEN` with R2 edit is available).
5. Frontend build + confirm the Pages **dev** deploy reads the new Parquet (deploy-dev runs
   on this PR's branch automatically); sanity-check a symbol's delta/gamma on the live URL.
6. Mark the draft PR ready / merge after review.

### Out of scope for this PR
- The separate D1 distributed-loader orchestration plan (PR #1,
  `plans/2026-08-05-distributed-loaders-d1-orchestration.md`) — do not implement here.
