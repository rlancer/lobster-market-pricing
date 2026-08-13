# AGENTS

Repo-wide policy for AI coding agents in this monorepo. Per-package guidance
lives next to the code — `frontend/AGENTS.md` (design-system rules) and
`loader/AGENTS.md` (loader engineering invariants). This file is the contract
for how work ships: read it before touching anything.

## Every change ships as a PR

New features — and all changes to tracked code — land via a **pull request
against `main`**. Never direct-push, and never leave work uncommitted.

`main` is branch-protected. Workflow:

1. Create a feature branch: `git checkout -b feat/<slug>`.
2. Commit your work there and push: `git push -u origin feat/<slug>`.
3. Open a PR against `main`: `gh pr create --base main`.
4. Confirm the required checks pass, then **stop — do not merge the PR.**
   Never self-merge or auto-merge: the maintainer reviews and merges
   (`gh pr merge <n> --merge`), and only a merge deploys to production.
   An open, green PR with both links reported is the completed deliverable —
   merging is the maintainer's call.

Do not amend or force-push after the PR is opened.

## Never leave work uncommitted

- A task is **not done** while its changes sit uncommitted in the working
  tree, staged, or parked on a local branch with no PR open.
- Finish each task by committing to a feature branch and opening a PR — even
  for small changes.
- If you're working on top of pre-existing uncommitted changes, commit only
  your own files; never sweep unrelated modifications into a PR.

## Report back: PR link + preview link

Every completed task reports back **both** links:

1. **PR link** — `https://github.com/rlancer/lobster-market-pricing/pull/<n>`.
2. **Preview link** — the Cloudflare Pages dev deploy. Any non-`main` branch
   push or PR auto-deploys to the `robs-options-slop-dev` Pages project via
   the `Deploy → dev` job in `.github/workflows/deploy.yml`. The URL is the
   branch name with any `/` replaced by `-`:

   `https://<branch-slug>.robs-options-slop-dev.pages.dev/`

   Example: branch `feat/free-openrouter-models` →
   `https://feat-free-openrouter-models.robs-options-slop-dev.pages.dev/`

Confirm the preview went live (the `Deploy → dev` GitHub Action succeeded and
the URL returns HTTP 200) before marking the task complete. The next push to
the branch redeploys the same URL.

> **Preview URLs (verified 2026-08-09):** the `<branch-slug>` URL above 404s
> in this repo — `pages deploy --branch` with a `/` in the name produces only
> hash-form deployment URLs. Get the real per-branch URL from
> `npx wrangler pages deployment list --project-name robs-options-slop-dev`,
> or use the stable dev URL below; either must return HTTP 200.

**Stable dev URL** — every dev build is also deployed to the project's
production branch (`dev`), i.e. `https://robs-options-slop-dev.pages.dev/`.
That URL is constant and gets clobbered by each deploy (no stable history).
Because the origin never changes, browser localStorage (the OpenRouter login
in the Copilot) persists there across deploys — use that URL for manual
testing instead of a per-branch URL, which requires re-logging in each time.

## Operational gotchas (learned the hard way — do not rediscover)

- **The local wrangler OAuth token HAS Pipelines read+write** (stream/sink/
  pipeline create all work). `wrangler whoami`'s scope list omits Pipelines —
  don't trust it. Only credentials that cannot be retrieved from anywhere:
  GitHub secret values (read-back is impossible) and stream ingest URLs are
  subdomain-credentials (never commit them).
- **Windows + wrangler:** never spawn `npx` directly from code
  (`execFileSync('npx', …)` fails — it's a `.cmd` shim). Invoke Node directly:
  `process.execPath, [<repo>/node_modules/wrangler/bin/wrangler.js, ...args]`.
  Read/forward root `.env` secrets (R2_DATA_CATALOG_TOKEN,
  PIPELINE_AUTH_TOKEN, WRANGLER_R2_SQL_AUTH_TOKEN) in-process; never echo them.
- **Windows + PowerShell + `@` refs:** PowerShell treats `@e1` as splat, so
  unquoted agent-browser (and similar) element refs vanish — `click @e22`
  becomes `click` with no selector ("Missing arguments" / "Element not found").
  Always quote them: `agent-browser click '@e22'`. Same for `fill`, `type`,
  `get`, etc.
- **Scheduler sleeps while the US market is closed** (global
  `MARKET_HOURS_ENABLED`) — even ungated jobs wait for the next market open.
  To verify a new pipeline immediately, publish through it directly (same code
  path a job uses) instead of waiting for a pass. Lake sinks flush on a ~300 s
  roll interval — data appears up to ~5 min after ingest.
- **Worker redeploys preserve secrets** (R2_SQL_TOKEN, PIPELINE_*_URL, …);
  CI needs only `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
- **Edit-tool hazard:** `read`/`grep` elide long bodies as `{ … }` — never
  anchor a text edit on that literal ellipsis text; it will corrupt the real
  body (happened in `frontend/src/api.ts`). Use `:raw` reads for unknown text.

## Documentation policy — no `PLAN-*.md` rollups

Root-level `*.md` files are **live documentation, not archives**. Do not add
new `PLAN-*.md` / `WORKER-*.md` planning or rollout docs at the root, and do
not leave stale ones around. The rule:

- **Plans are transient.** While a feature is in flight, its plan/runbook may
  live on the feature branch (or nowhere — the PR description suffices).
- **On ship, convert, then delete.** Before merge, fold the still-accurate
  facts into the canonical docs — `README.md` (architecture, API, config) and
  the per-package `AGENTS.md` (`loader/AGENTS.md` for loaders, `frontend/AGENTS.md`
  for the design system) — and delete the plan file in the same PR or on the
  feature branch. No plan file survives the merge.
- **No scratch in the repo.** Handoff notes, version-ID snapshots, outage
  trackers, and "historical record" migrations are not documentation; delete
  them rather than relabel them.

## Repo map

- `frontend/` — Vite + React UI (Copilot, market screener, research, SQL lab,
  monitor, docs portal).
- `worker/` — Cloudflare Worker backend: Iceberg lake over R2 SQL → JSON
  (`/api/*`), plus the `/loader/*` pass-through.
- `loader/` — CBOE → Cloudflare Pipelines → R2 Data Catalog ingestion
  (`cboe-to-r2`): continuous Durable Object scheduler, OHLC jobs, D1 state.
- Root `README.md` — architecture, full API reference, run/deploy
  instructions; deeper operational docs live in the per-package `AGENTS.md`
  files. No `PLAN-*.md` / `WORKER-*.md` rollups at the root (see
  "Documentation policy" above).