# Worker Loader Pivot (retire the container)

**Status:** Proposed design — not yet implemented.
**Owner:** rlancer
**Why:** remove recurring Cloudflare Containers cost and a whole moving part by
moving the CBOE fetch + normalize + Pipeline-publish path off the Python
container and into a plain Worker.

## Current architecture

```text
CboeContinuousLoader (Durable Object, alarm loop, D1 symbol_state)
  └─ tick(): pick due batch -> container /run -> apply results
        CboeLoaderContainer (Python, /app/loader.py)
          └─ per symbol: CBOE GET -> OCC normalize -> Pipeline POSTs
```

The DO (alarm loop, D1 per-symbol state, batching, market-hours gating) is
already cheap — it is the **container** (a 10-min-alive Python process doing the
fetches/writes) that carries the recurring cost. Containers bill vCPU/memory
time while alive; this workload is almost entirely I/O-bound.

## Why a Worker is now viable

Previously the blocker was Workers' per-invocation **subrequest limit**. Since
2026-02 that is no longer an issue:

- Paid-plan Workers default to **10,000 subrequests per invocation**, configurable
  up to 10M ([Cloudflare changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)).
- A full 503-symbol pass needs ~1,300–1,600 subrequests (1 CBOE GET + 1–3
  Pipeline POSTs per symbol) — comfortably within the default.

Cost model inverts: **Workers bill CPU time, not wall-clock**. Because the pass
is network-bound, its CPU cost on a Worker is near-zero, vs. the container
billing for the whole wall-clock it stays alive. And you delete the Docker
image, the Python runtime, and the `sleepAfter` idle lifecycle.

## Target architecture

```text
CboeContinuousLoader (Durable Object, alarm loop, D1 symbol_state)  [unchanged]
  └─ tick(): pick due batch -> fetch+normalize+publish in-process -> apply results
        ported loader logic (TS) in this Worker, no container
```

- Port `container/loader.py` → a new TS module in `loader/src/` (e.g.
  `run-symbols.ts`):
  - `fetchSymbol(symbol)` — CBOE GET with retry/`retry-after` backoff and the
    `cboe-to-r2/0.2` User-Agent (required by the ingest endpoint).
  - `occFields` / `normalizeContract` — OCC symbol → expiration / type / strike
    parsing and the contract field mapping.
  - `normalizeSymbols`, `BuildRunRequest`-style pipeline POSTs (runs /
    underlyings / contracts / errors) with the same retry + idempotency keys
    (`run:{run_id}:…`).
- `tick()` calls it **directly** (no `/run` HTTP hop), bounded-concurrency via a
  small promise semaphore (`SYMBOL_CONCURRENCY`, default 8), mirroring the
  Python thread pool just landed. Cloudflare Workers are natively async, so no
  GIL/thread artifact at all.
- **Delete:** `container/`, `Dockerfile`, the `CboeLoaderContainer` binding and
  `"containers"` block in `wrangler.jsonc`, the `getContainer` call, and the
  `WRITE_MODE=stdout` local mode (or keep the module as a pure function the DO
  calls, testable directly).

## File-by-file

| File | Change |
|---|---|
| `loader/src/run-symbols.ts` | **new** — ported fetch/normalize/publish |
| `loader/src/continuous-loader.js` | `tick()` calls `runSymbols(batch)`; drop container call |
| `loader/src/index.js` | remove `CboeLoaderContainer`; keep DO routing + auth |
| `loader/wrangler.jsonc` | remove `"containers"` block + binding |
| `loader/Dockerfile`, `loader/container/` | delete |
| `loader/README.md` | update architecture + remove container instructions |
| `loader/package.json` | add TS build step / deps if not bundling via wrangler |

## Invariants preserved

- DO single-flight, cadence/backoff, market-hours gating, re-arm-on-fetch.
- Per-symbol output record schema, failure capture, `run_id`/`as_of_date`/
  `fetched_at` snapshot semantics; idempotency keys.
- Contract-batch chunking (`MAX_BATCH_RECORDS`-equivalent) across concurrent
  symbols — a lock-free chunking (append + flush >= N, out-of-line POST) keeps
  output byte-identical to the current path (verified approach in the parallel
  Python change).

## Verification

- **Unit/determinism:** harness the DO with a stub Pipeline and run the same
  symbol set at `SYMBOL_CONCURRENCY=1` vs `8`; assert byte-identical
  contracts/underlyings (the pattern already green on the Python change).
- **Subrequest headroom:** confirm a full pass stays < billed subrequest budget.
- **Live cadence:** a 250-symbol pass should beat ~3 min (vs ~36 min serial);
  confirm symbols refresh within the 15-min window intraday.

## Rollout

1. Land the port behind the existing DO (no behavior change to batching).
2. Merge the container-removal in the same PR (both worker + deployment are
   code-only; no container image to build → simpler CI).
3. Confirm `/loop/status.last_pass.duration_ms` and freshness over one live
   session before declaring success.

## Prerequisite / caveat

Needs a **paid-billing Workers plan** for the 10k-subrequest headroom. On the
free plan (50 subrequests/invocation) a batch would cap at ~20 symbols and the
full cycle would be slow — confirm the plan before starting.

## Open questions

- Keep `WRITE_MODE=stdout` smoke mode (local, no pipeline) or drop it?
- `SYMBOL_CONCURRENCY` default: 8 (conservative, CBOE rate-limit) vs higher.
- Whether to fold an optional CBOE rate-limiter in up front.