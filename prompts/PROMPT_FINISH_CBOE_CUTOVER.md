# Handoff prompt — finish the CBOE cutover (fresh session)

Paste this into a fresh session. It stays brief on purpose — the full spec lives in the
plan doc it points to.

---

Finish the in-progress CBOE data-pipeline cutover (see
`plans/2026-08-05-cboe-data-pipeline-github-actions.md`, especially the
**"Implementation status & handoff"** section appended at the end — read it first).

Repo: `C:/Users/Rob/Desktop/screener_glm52` (branch `wip/cboe-cutover`, draft PR).

The code cutover is mostly written but **not finished**: the local `data/options.duckdb` is
inconsistent (partial write from a timed-out run), and nothing new is on R2 yet.

Do the following:

1. **Refactor `backend/screener/download_cboe.py` `run()`** to write everything in a single
   batched transaction (one `executemany` for all contract rows, one for underlyings, one
   for the download log) instead of the current slow per-symbol `DELETE`+`INSERT` loop.
   The downloader must exit non-zero if any symbol fails so CI never exports/uploads
   partial data (already partly implemented — keep it).
2. **Full clean re-download** with `mise run download-cboe`. Success criteria: 503
   underlyings, ~500–550k contracts, `download_log` = 503 rows, 0 errors, near-ATM greeks
   non-null.
3. **Export + upload**: `mise run export-parquet`, then `mise run upload-r2`
   (`CLOUDFLARE_API_TOKEN` with R2 edit access is set). Verify the new Parquet includes
   `theo`/`bid_size`/`ask_size` and is readable on the live R2 URL.
4. **Frontend/dev e2e**: confirm the frontend build passes and the Pages **dev** deploy
   (run automatically on this branch) reads the new Parquet — spot-check a symbol's
   delta/gamma in the app/API.
5. **Wrap up**: update the plan doc's status section, mark the draft PR ready, and merge
   after review.

Constraints / gotchas (also in the plan doc):
- CBOE `iv` is already a decimal → copy verbatim, do **not** divide by 100.
- Keep `option_contracts.symbol` as the requested **dotted** symbol (BRK.B) — the OCC root
  is dot-less and would break the `underlyings` join.
- Default `--sleep` 0.5s + 429/5xx backoff retries (CBOE throttles faster runs).
- On Windows, never taskkill `//IM node.exe`/python.exe (would kill pi itself).
- Do **not** implement the D1 distributed-loader plan (that's a separate PR).
