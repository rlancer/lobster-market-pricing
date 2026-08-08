# Handoff — Worker Loader Pivot live validation (IN PROGRESS)

Read `loader/WORKER-LOADER-PIVOT.md`, `loader/README.md`, `loader/AGENTS.md` for
full context. This is the state at handoff (2026-08-07 ~21:30 ET).

## Where we are
The container was fully retired; the loader runs in-process (`src/run-symbols.ts`
via `runSymbols`), wired into the DO `tick()` and the public one-shot `POST /run`.
All code is done and unit-tested. We are mid **live validation** on prod.

**Prod worker is DEPLOYED and its loop is currently running a live pass.**

## Deployed / live state
- Worker: `cboe-to-r2` at https://cboe-to-r2.robertlancer.workers.dev
- Latest deploy Version ID: `d1418838-7bd9-4e5d-8c6d-ba514076c7ed`
- Account: robert.lancer@gmail.com (3315bb3e7d2e3556bfea6fb3947a890e), wrangler
  already authenticated on this machine.
- D1 `cboe-loader-state` exists, seeded 503 symbols, tables `symbol_state` +
  `loader_meta` present.
- Secrets (LOADER_TOKEN, PIPELINE_*_URL, PIPELINE_AUTH_TOKEN) are set on the
  worker as Wrangler secrets (write-only; **LOADER_TOKEN value is NOT available
  locally** — do not try to read it).

## CRITICAL — MARKET_HOURS_ENABLED (DONE — reverted to true)
**Validation FAILED** (see below), so the bypass was disabled: `MARKET_HOURS_ENABLED`
is reverted to `"true"` and redeployed (Version `daa95437`). The loop now sleeps
until the next open (Monday 2026-08-10 13:30 ET). Do NOT flip it back to `"false"`
without an explicit live-market validation window — with it off, the loop churns
passes 24/7 and a broken batch would OOM the DO all weekend.

## Live validation so far
- Deploy cutover worker: OK (needed a `deleted_classes` migration for the
  retired `CboeLoaderContainer` DO — added as tag `v3` in `wrangler.jsonc`).
- `/health` 200; `/loop/status` shows DO armed, 503 symbols, D1 working.
- **Found + fixed: stuck `passing` flag** — a stranded single-flight marker from
  earlier DO resets would have permanently stalled the loop. `tick()` now treats
  a marker older than `LOADER_RUN_TIMEOUT_SECONDS`+60s (or a legacy boolean) as
  stale and clears it. Test added.
- **Found + fixed: D1 "too many SQL variables"** — `markAttempts` built one
  `UPDATE ... WHERE symbol IN (?,…)` with 250 binds (batch 250), exceeding D1's
  ~100-variable limit (prod previously ran batch 10, so it was latent). Fixed by
  chunking into 90-per-in-list. Test added.
- **Found + fixed: `ensureArmed` re-arm logic** — changed to re-arm to
  `min(existing, nextWakeMs)`: never delays a pending alarm (a monitor polling
  faster than the cadence can't defeat it) but pulls the alarm earlier when
  `MARKET_HOURS_ENABLED` is toggled off.
- **Live 250-symbol pass FAILED validation.** The pass took ~607s and timed out
  at `LOADER_RUN_TIMEOUT_SECONDS=600` (`transport_error` in `last_pass`,
  `run_id: null`). `wrangler tail` showed `"Durable Object's isolate exceeded
  its memory limit and was reset"` — `runSymbols` buffers every symbol's parsed
  contracts in the `results` array for the whole pass, and a 250-batch OOM'd the
  DO isolate. After the OOM reset the freshly-set `passing` flag briefly stalled
  the loop (~660s) until the stale-marker self-heal cleared it.
- **Root cause of the 600s duration:** per-symbol publication is serialized
  through one `publishChain` for deterministic output; ~2250 one-at-a-time POSTs
  × ~0.27s ≈ 600s. CBOE fetches themselves are fast (~1–4s; NVR still 403).

### Fixes applied (deployed `daa95437`, 12→20 tests green, tsc clean)
1. **OOM:** `runSymbols.doFlush` now frees each drained symbol's records
   (`results[i] = undefined`) so a pass no longer pins all contracts in memory.
2. **Timeout false-success:** `tick()` now backs off the WHOLE batch on a
   `transport_error` (did not confirm completion) instead of marking every
   symbol fresh, so `run_id` tracking works and nothing is recorded loaded
   without a confirmed publish. Regression test added.
3. **`LOADER_BATCH_SIZE` 250 → 40** so a pass completes well inside the timeout.
   Serialized-publish throughput means a full 503 refresh still spans multiple
   passes and a symbol can age up to ~20–25 min (documented in README).

## What to do next (fresh session)
1. **Revalidate on the live market day (Monday 2026-08-10).** Loop is gated off
   until then (`MARKET_HOURS_ENABLED=true`, alarm → Monday 13:30 ET). When you
   want a live pass despite a closed market, flip
   `MARKET_HOURS_ENABLED` to `"false"` in `loader/wrangler.jsonc`, redeploy, and
   confirm a clean `last_pass` (batch 40 → `run_id` set, `succeeded=40`,
   `transport_error` null, `duration_ms` well under 600). Then flip it back.
2. Check `/loop/status` for `last_pass.run_id` (non-null) and `passing` cleared
   after the pass.
3. Confirm the new success criteria: a 40-symbol pass
   `duration_ms` well under the timeout with `run_id` set and `run` status
   `complete`; NVR stays a per-symbol failure (403 → backoff), NOT a transport.
4. Verify no `wrangler tail` `"...memory limit and was reset"` events — the
   per-symbol record-freeing fix should prevent the OOM.
5. Run `npx tsc --noEmit` and `npx vitest run` before finishing.

## Notes / gotchas
- DO alarms fire reliably; the in-progress confusion was caused by MY OWN
  `/loop/status` polling keeping the DO busy (before the min-based ensureArmed
  fix). Now polling is safe. When waiting for a pass, minimize requests and
  poll every ~15s, not constantly.
- All 503 symbols were seeded with `next_attempt_after` in the past, so when
  gating is off the loop keeps passing until the universe is refreshed, then
  idles (due=0) — this is expected during the bypass.
- Do not run `wrangler secret put LOADER_TOKEN` — you don't have the current
  value and overwriting it would break /run auth irrecoverably.
- No git commit has been made for any of this work.

## Files changed in this task
- `loader/src/run-symbols.ts` (new), `loader/src/run-symbols.test.ts` (new)
- `loader/src/continuous-loader.js` (wired runSymbols, self-healing passing,
  chunked markAttempts, min-based ensureArmed)
- `loader/src/continuous-loader.test.ts` (wiring + regression tests, new)
- `loader/src/index.js` (one-shot /run in-process, dropped container)
- `loader/src/index.test.ts` (new)
- `loader/wrangler.jsonc` (removed container/binding/migration v1+v3 add,
  MARKET_HOURS_ENABLED TEMP-off)
- `loader/package.json` / `package-lock.json` (dropped @cloudflare/containers)
- Deleted: `loader/container/`, `loader/Dockerfile`
- `.github/workflows/deploy-loader.yml`, `loader/README.md`, `loader/AGENTS.md`
