# PLAN — ETL Job-Orchestration Foundation (`EtlScheduler`)

Converts the bespoke `CboeContinuousLoader` into a generic **job registry + one
scheduler** DO, so every enrichment source (CBOE options, OHLC, dividends, risk-free
rate, earnings, EDGAR) is a *registered handler* instead of a new orchestrator. See
`DATA-ENRICHMENT.md` for the source catalog this foundation serves.

## Grounding (current architecture)

- `loader/src/continuous-loader.js` — `CboeContinuousLoader` DO alarm loop. Owns the
  scheduler machinery: `seedIfEmpty`, `pickDue`, backoff tiers (`60s→5m→30m→cap`),
  single-flight (`passing` flag + stale self-healing), `withTimeout`, market-hours
  gating, `applyResults`, `storeMeta`, re-arm-on-every-request.
- `loader/migrations/0001_initial.sql` — `symbol_state` (per-symbol item state) +
  `loader_meta` (key/value stats). `symbol_state` is hard-wired to CBOE symbols.
- `loader/src/index.js` — routes `/run` (one-shot CBOE refresh), `/loop/*`
  (status/symbols/trigger); arms the DO on every request.
- Job handlers (already pure, uniform shape): `runSymbols` (CBOE options) and the
  prototype `publishOhlc` (OHLC + realized vol).

The scheduler **concepts are reusable**; the implementation is fused to
CBOE/options/`symbol_state`/market-hours.

## Design decisions (locked)

1. **One scheduler primitive: the DO alarm loop.** Already the cheapest, proven
   option for a self-rescheduling loop. Do **not** adopt Workflows/Queues in the
   foundation.
2. **Two-level state.**
   - `job_state` (new) — the *schedule ledger*: one row per job (cadence, backoff,
     last success, enabled, market-gated policy).
   - existing `symbol_state` stays as the *item store* for item-scoped jobs (CBOE).
   Each job has its own item identity (a `job_id` column names which store a due
   row belongs to).
3. **Market-hours becomes a per-job policy flag**, not loop logic. `cboe-options`:
   gated. `ohlc-daily` / `dividends` / `edgar` / `freid`: ungated (daily, run
   regardless of session).
4. **Handler contract:** `(env, items, jobState) => Promise<void>`; a handler maps
   items → publishes → reports per-item failures via an `onItemFailure(item, err)`
   callback or a returned failure list. `runSymbols` and `publishOhlc` already
   conform to an items-in / failures-out shape; wrap thin adapters.
5. **Routes become job-aware** but keep `/loop/*` as back-compat aliases for
   `cboe-options` (a monitor polls `/loop/status` and `/loop/symbols` — see
   WORKER-LOADER-HANDOFF — so those URLs must keep working).

## Files

New:
- `loader/migrations/0002_job_state.sql` — `job_state` table.
- `loader/src/scheduler.ts` — generic `EtlScheduler` DO + helpers, extracted from
  `continuous-loader.js` (seed / pickDue / backoff / single-flight / wake /
  market-gate-policy). Job-agnostic.
- `loader/src/jobs/registry.ts` — job definitions: `job_id → { handler, cadence,
  market_gated, itemStore }`.
- `loader/src/jobs/cboe-options.ts`, `loader/src/jobs/ohlc-daily.ts` — thin adapters
  around `runSymbols` / `publishOhlc`.
- `loader/src/scheduler.test.ts` — scheduler unit tests (stubbed D1 + fake timers).

Modified:
- `loader/src/continuous-loader.js` → replaced by `scheduler.ts` (`EtlScheduler`);
  remove `CboeContinuousLoader`/`DRIVER_ID` or keep as a thin alias.
- `loader/src/index.js` — job-aware routes + arm; keep `/loop/*` aliases.
- `loader/wrangler.jsonc` — rename DO binding `CBOE_CONTINUOUS_LOADER` →
  `ETL_SCHEDULER`; add `new_sqlite_classes`/`deleted_classes` migration tag;
  per-job cadence vars stay in `vars`.
- Existing `continuous-loader.test.ts` → migrated to `scheduler.test.ts`.
- `DATA-ENRICHMENT.md` → mark foundation done.

## Phases

### Phase 1 — Extract scheduler core (CBOE behavior unchanged) — **DONE**
1. Migration `0002_job_state.sql`; apply to local D1 + on deploy.
2. Extract `tick()` internals into a generic `EtlScheduler` (job-agnostic state
   update; market gate via per-job policy).
3. Migrate `CboeContinuousLoader` → `EtlScheduler`; keep the CBOE path
   **byte-identical** so current tests pass unchanged and `/loop/*` still works.
4. Rename DO binding + `DRIVER_ID`. Update deploy/migration tags.
   **Acceptance:** existing test suite green; `/loop/status` + `/loop/symbols`
   unchanged in `wrangler dev`.

### Phase 2 — Job registry + handlers — **DONE**
1. `job_state` seeded with `cboe-options` (continuous, gated, item store
   `symbol_state`) and `ohlc-daily` (daily cadence `86400`, ungated, whole
   universe batch via `sp500.json`).
2. `jobs/registry.ts` + thin adapters `cboe-options.ts`, `ohlc-daily.ts`.
3. Scheduler routes per job through its handler; scopes due-scan by `job_id`.
   **Acceptance:** new `scheduler.test.ts` — seed, due-scan, backoff tiers,
   single-flight, market-gate-policy per job.

### Phase 3 — Routes + observability — **DONE**
1. `/jobs` (list + state), `/jobs/{id}` (status), `/jobs/{id}/trigger`
   (auth-gated manual kick), job-aware `/status`.
2. Keep `/loop/*` as aliases for `cboe-options` (monitor back-compat).
   **Acceptance:** `wrangler dev` — `/jobs` lists both jobs; `/loop/status` still
   returns the CBOE pass summary.

### Phase 4 — Register OHLC end-to-end + verify — **DONE** (tables provisioned + live ingest verified; scheduled pass runs at next market open)
1. Wire `ohlc-daily` handler to `publishOhlc` over the universe with a dry-run
   pipeline probe.
2. End-to-end: a scheduled OHLC pass fetches + normalizes + publishes to the
   `options.ohlc`/`options.realized_vol` probe tables (once provisioned).
   **Acceptance:** `ohlc-daily` runs on daily cadence, skipped during tests where
   no pipeline URL is set (dry-run), publishes correctly when configured.

## Risks / decisions

- **DO binding rename is a breaking deploy.** Sequence it carefully: add
  `new_sqlite_classes`/`deleted_classes` tags so old DOs retire cleanly; keep
  `/loop/*` aliases until the monitor is on the new `/jobs` URLs.
- **Adding a future job = one registry entry.** That's the whole point — validate
  this with the third grain (e.g. dividends/EDGAR) in a follow-up, not in this
  foundation slice.
- Do not reach for Workflows/Queues yet (cost + no fan-out need). Revisit Queues
  only if per-symbol latency requires elastic fan-out.

## Verification (final)

- `npm run typecheck` clean.
- `npx vitest run` all green (migrated scheduler tests + run-symbols + ohlc).
- `wrangler dev` with local D1: `/jobs`, `/jobs/cboe-options`, `/jobs/ohlc-daily`,
  `/loop/status` all respond; OHLC dry-run pass logs `pass_completed`.
- Deploy loader; confirm DO migration applies cleanly, CBOE loop keeps running.

## Explicitly out of scope (this slice)

- Provisioning new Pipeline/Iceberg tables (`options.ohlc`, `options.realized_vol`).
- Queues/Workflows adoption.
- Writing the EDGAR/FRED/dividend handlers themselves (only the registry plumbing
  that will host them).
