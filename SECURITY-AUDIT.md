# Security Audit — Bill-Shock Focus

**Date:** 2026-08-06
**Scope:** `rlancer/lobster-market-pricing` and `rlancer/options-lake` (both **public** GitHub repos)

> **Note (2026-08-06):** The two audited repos have been merged into a single monorepo (`lobster-market-pricing`). The former `rlancer/options-lake` loader is now `loader/` within this repo. Findings below reference the old repo names for provenance; the affected code now lives at `loader/` (Pipeline URL exposure), `worker/` (screener API), and root `.env` (secret hygiene).

**Goal:** Identify security issues that could cause a surprise Cloudflare bill. Not exhaustive; focused on cost-abuse vectors.

---

## Summary

| Severity | Count | Headline |
|---|---|---|
| 🔴 Critical | 1 | ✅ RESOLVED — Pipeline ingest URLs rotated, moved to secrets, history scrubbed, auth enabled |
| 🟠 High | 1 | Screener `/api/query` — unbounded compute, no rate limit |
| 🟡 Medium | 3 | Unauth container wake; R2 CORS in history; cross-schema reads |
| 🟢 Low / Info | 7 | Secret hygiene, account ID, gitignore gaps, etc. |

---

## 🔴 CRITICAL — Pipeline ingest URLs leaked in public git — ✅ RESOLVED (2026-08-06)

> **Status: RESOLVED.** All 4 fix items applied: (1) ingest URLs rotated — old unauthenticated streams deleted, new authenticated streams created; (2) `PIPELINE_*_URL` migrated from `wrangler.jsonc` vars to Wrangler secrets; (3) URLs redacted from `AGENTS.md`, `README.md`, and git history (scrubbed via `git-filter-repo`, force-pushed); (4) Pipeline-side auth enabled (`x-pipeline-auth-token` forwarded from Worker to container, `PIPELINE_AUTH_TOKEN` secret set). End-to-end verified: unauthenticated POST → 400, authenticated POST → 200 with data in R2 SQL.
**Repos:** `rlancer/options-lake` (findings `PIPELINE-*`, `R2-PIPELINE-URLS-IN-GIT`)

The 3 Cloudflare Pipeline ingest URLs are unauthenticated **write** endpoints — the 32-hex subdomain *is* the credential. Anyone with the URL can POST arbitrary data into the R2 lake (`options.option_contracts`, `options.underlyings`, `options.refresh_runs`), racking up Pipeline compute + R2 storage costs.

Leaked in **3 git-tracked files** in the public `rlancer/options-lake` repo:

| File | Lines | Streams exposed |
|---|---|---|
| `wrangler.jsonc` | 7–9 | all 3 (Runs, Contracts, Underlyings) |
| `AGENTS.md` | 30–32, 64–66 | all 3 (twice) |
| `README.md` | 90–92 | Runs + Underlyings full; Contracts truncated to 31 hex (last digit brute-forceable in 16 tries) |

The URLs also persist in **git history** (commits `b8bd392`, `ab4286c`, `7d60c5e`) — scrubbing the working tree alone doesn't close it; every clone/fork retains them.

The README documents that the streams are unauthenticated, and the Worker never forwards an `x-pipeline-auth-token` even though the loader supports it — so there's no credential gate at all right now.

### Fix (priority order)

1. ~~**Rotate the ingest URLs** in the Cloudflare dashboard (create new Pipeline streams, update the deployed Worker/container to point at them). The current URLs are burned — they're in public history.~~ **Done.**
2. ~~Move `PIPELINE_*_URL` from `vars` → **Wrangler secrets** (`wrangler secret put`) so they're not in `wrangler.jsonc`.~~ **Done.**
3. ~~Redact the URLs from `AGENTS.md` + `README.md` (replace with "see Cloudflare dashboard / `wrangler secret`").~~ **Done.** (git history also scrubbed via `git-filter-repo`.)
4. ~~Enable Pipeline-side auth if available and forward it via `x-pipeline-auth-token` from the Worker (the loader already reads it).~~ **Done.** New streams created with `--http-auth`; `PIPELINE_AUTH_TOKEN` secret set; Worker forwards `x-pipeline-auth-token` to container.

---

## 🟠 HIGH — Screener `/api/query` unbounded compute, no rate limit

**Repo:** `rlancer/lobster-market-pricing` (findings `SCREENER-001`, `SCREENER-003`, `SCREENER-004`, `SCREENER-002`, `SCREENER-UNAUTH-PUBLIC-API`)

The screener-api Worker has no auth and no rate limit on any endpoint. The cost multiplier is `POST /api/query`:

- Accepts arbitrary caller SQL, runs it against R2 SQL (billed to you).
- Read-only guard is solid — only `SELECT/WITH/DESCRIBE/SHOW/EXPLAIN`, blocks `INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE`, wraps in `SELECT * FROM (...) LIMIT N`. No writes or data destruction. **But reads cost compute**, and there's no throttle.
- `runQuery` is **uncached** (no cache key passed to `r2sql`), so every POST is a live R2 SQL query. An attacker looping `curl -X POST .../api/query -d '{"sql":"SELECT * FROM options.option_contracts"}'` drives unbounded R2 SQL compute.
- The in-isolate `Map` cache on other endpoints is per-isolate (not shared across the many Worker isolates), and cache keys include full WHERE clauses — trivially busted by varying params.
- `CORS_ORIGIN="*"` makes it worse: any third-party webpage can fire cross-origin POSTs to `/api/query`.

### Fix

- Add a Cloudflare **rate-limiting rule** (WAF or the rate-limiting binding) on `/api/query` — e.g. 10 req/min per IP.
- Pass a cache key in `runQuery` (hash the SQL) so identical queries dedup for 5 min.
- Narrow `CORS_ORIGIN` to `lobster.mp` (your frontend origin) instead of `*`.
- Optionally gate `/api/query` behind a shared-secret Bearer token, or move SQL Lab to a dev-only flag.

---

## 🟡 MEDIUM

### M1. `/health` + `/status` wake the container without auth

**Repo:** `rlancer/options-lake` (`src/index.js:27-29`, findings `CONTAINER-WAKE-UNAUTH`, `CBOE-UNAUTH-HEALTH-STATUS`)

The container has `sleepAfter=10m`, so each unauthenticated ping to `/health` or `/status` keeps it awake for 10 min of compute. An attacker polling `/health` keeps it alive permanently. Only `/run` is gated by `LOADER_TOKEN`.

**Fix:** Gate `/health` and `/status` behind `LOADER_TOKEN`, or restrict to internal Cloudflare IPs / a Cron Trigger only.

### M2. Permissive `r2-cors.json` (origins `*`) in screener git history

**Repo:** `rlancer/lobster-market-pricing` (commits `887c95f`, `5324d86`, finding `R2-CORS-PERMISSIVE-IN-HISTORY`)

A `r2-cors.json` with `origins:["*"]` existed and was deleted. If that CORS rule was ever applied to the `cboe-options-data` bucket's public/dev domain, any site could read bucket objects. Current configs have no `r2_buckets` binding — clean. Dashboard state can't be verified from the repos.

**Fix:** Verify in the Cloudflare dashboard that no public R2.dev/custom-domain binding or `origins:*` CORS rule is active on `cboe-options-data`.

### M3. `/api/query` reads any schema, not just `options.*`

**Repo:** `rlancer/lobster-market-pricing` (`worker/src/index.ts:378-386`, finding `SCREENER-002`)

`runQuery` allowlists the first keyword but not the tables. A caller can `SHOW TABLES` or query any table in the same bucket. Currently only `options.*` exists, so low practical impact today, but any future table becomes exfiltrable.

**Fix:** Parse table references and require `FROM options.<known-table>` only.

---

## 🟢 LOW / Informational

### L1. `frontend/.env` is git-tracked (screener)

Contains only the public `VITE_API_BASE` URL — not a secret today, but `frontend/.gitignore` has no `.env` rule, so a future secret added there gets committed.

**Fix:** `git rm --cached frontend/.env`, add `.env` to `frontend/.gitignore`, or rename to `.env.production`.

### L2. `R2_SQL_TOKEN` correctly gitignored in both repos

Never committed (`git log -S` empty). Same token value `cfat_shUCBUL...` duplicated across both repos' local files. **Fix:** Rotate if the Desktop was ever shared/synced.

### L3. `tools/load_sp500.py` defaults `LOADER_TOKEN` to `"local-loader"`

Deployed Worker is safe (`authorized()` returns false when token unset), but the local fallback is weak. **Fix:** Error instead of defaulting.

### L4. Account ID in `wrangler.jsonc` vars

`3315bb3e7d2e3556bfea6fb3947a890e` is an identifier, not a credential. Optional to move to a secret.

### L5. `lit()` SQL escaper is correct — no injection

Strings: doubles single quotes. Numbers/booleans/NULL emitted literally. Sort column `SORT_WHITELIST`-gated. `screen`/`notebook` use `lit()` for all user values. ✓

### L6. R2 bucket has no public binding

`cboe-options-data` is accessed only via authenticated R2 SQL REST in both repos. ✓

### L7. Loader prints full ingest URL to stdout in debug mode

`WRITE_MODE=stdout` (debug only) prints `{"url": url, "payload": payload}`. Production uses `WRITE_MODE=pipeline` which doesn't log the URL. Low risk unless debug mode runs in a shipped log pipeline.

---

## Recommended immediate action

~~Only the **Pipeline URLs** are genuinely urgent — public, unauthenticated, and writable.~~
**✅ RESOLVED (2026-08-06): items 1–2 below are done.**

1. ~~Rotate the ingest URLs in the Cloudflare dashboard (current ones are burned).~~ **Done** — old streams deleted, new authenticated streams created.
2. ~~Move `PIPELINE_*_URL` to Wrangler secrets; redact from docs.~~ **Done** — migrated to secrets, redacted from docs, git history scrubbed.
3. Gate `/health`/`/status` behind `LOADER_TOKEN`.
4. Add a rate-limit + cache key to the screener `/api/query`; narrow CORS to `lobster.mp`.

---

## Methodology

Three parallel `security-reviewer` agents audited:
- **Pipeline URL exposure** — grep + `git log -S` across `options-lake` for `ingest.cloudflare.com` and `PIPELINE_*_URL`.
- **Screener endpoints** — full read of `worker/src/index.ts`, `api.ts`, `vite.config.ts`, `wrangler.jsonc`, `.env`/`.dev.vars`, git history (`git log -S cfat_`, full token value, `git ls-files`).
- **R2 bucket + secret hygiene** — wrangler bindings, CORS config, git history of `.dev.vars`/`.env`/`r2-cors.json`, `.gitignore` completeness.

Each finding includes file:line evidence, severity, and a fix recommendation. Full per-finding evidence available in the agent transcripts.
