# Follow-Up Actions

Created 2026-08-06 after resolving the CRITICAL security finding (Pipeline
ingest URL leak) and closing PR #3.

---

## 1. Retest GitHub Actions deploys (blocked — GitHub outage)

GitHub Actions is in a **critical outage** as of 2026-08-06. Workflow runs
are failing or stuck queued for extended periods. The loader deploy has been
stuck in `queued` for 40+ minutes.

**Check outage status:** https://www.githubstatus.com

Once the outage clears, retrigger both workflows:

```bash
# Loader deploy — builds + pushes the container image (Dockerfile now fixed
# to COPY container/loader.py), deploys the cboe-to-r2 Worker + container.
gh workflow run deploy-loader.yml --ref main

# Screener deploy — builds frontend, deploys to Cloudflare Pages (prod),
# deploys the screener-api Worker. Triggers automatically on push to main,
# but can be manually re-run:
gh run rerun <failed-run-id>
```

### What each workflow needs

| Workflow | GitHub Secrets | What it deploys |
|---|---|---|
| `deploy-loader.yml` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `cboe-to-r2` Worker + container image |
| `deploy.yml` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `screener-api` Worker + Cloudflare Pages (frontend) |

### Verifying the loader deploy

After the deploy succeeds:

```bash
# Container should respond (no longer crashes with exit code 2)
curl -s https://cboe-to-r2.robertlancer.workers.dev/health

# /run should reject without LOADER_TOKEN
curl -s -o /dev/null -w "%{http_code}" -X POST https://cboe-to-r2.robertlancer.workers.dev/run
# Expected: 401
```

---

## 2. Rotate LOADER_TOKEN

The `LOADER_TOKEN` was set to a test value (`loader-test-1786038514`) during
the security fix. Rotate it to a real secret after the container deploy
succeeds:

```bash
cd loader && npx wrangler secret put LOADER_TOKEN
```

---

## 3. Remaining security audit items

The CRITICAL finding is resolved. These are the remaining findings from
`SECURITY-AUDIT.md`, in priority order:

### HIGH — Screener `/api/query` unbounded compute, no rate limit

- Add a Cloudflare rate-limiting rule on `/api/query` (e.g. 10 req/min per IP).
- Pass a cache key in `runQuery` (hash the SQL) so identical queries dedup.
- Narrow `CORS_ORIGIN` from `*` to `lobster.mp` in `worker/wrangler.jsonc`.
- Optionally gate `/api/query` behind a shared-secret Bearer token.

### MEDIUM

- **M1.** Gate `/health` and `/status` behind `LOADER_TOKEN`, or restrict to
  internal Cloudflare IPs / Cron Trigger only. (`loader/src/index.js:28`)
- **M2.** Verify in the Cloudflare dashboard that no public R2.dev/custom-domain
  binding or `origins:*` CORS rule is active on `cboe-options-data`.
- **M3.** Parse table references in `runQuery` and require
  `FROM options.<known-table>` only. (`worker/src/index.ts:378-386`)

### LOW / Informational

- **L1.** `git rm --cached frontend/.env`, add `.env` to `frontend/.gitignore`.
- **L2.** Rotate `R2_SQL_TOKEN` if the Desktop was ever shared/synced.
- **L3.** `tools/load_sp500.py` defaults `LOADER_TOKEN` to `"local-loader"` —
  error instead of defaulting.
- **L4.** Account ID in `wrangler.jsonc` vars — optional to move to a secret.

---

## 4. Loader full-universe validation

After the container deploy succeeds and `LOADER_TOKEN` is rotated, run the
full S&P 500 load (503 symbols). The Pipeline streams, sinks, and pipelines
are already created and running with authentication enabled.

Load procedure:
1. Run a 2-symbol smoke test (1 valid + 1 invalid) to validate failure publication.
2. Run the full 503-symbol refresh via the protected `/run` endpoint.
3. Validate completeness via R2 SQL (status, symbol counts, contract counts).
4. Track storage and catalog usage in the Cloudflare dashboard.
5. Do not enable a schedule until manual full refreshes are stable.
