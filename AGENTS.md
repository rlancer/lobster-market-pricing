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
4. Confirm the required checks pass, then merge when ready
   (`gh pr merge <n> --merge`) and assume the change is live.

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

1. **PR link** — `https://github.com/rlancer/options-db/pull/<n>`.
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

**Stable dev URL** — every dev build is also deployed to the project's
production branch (`dev`), i.e. `https://robs-options-slop-dev.pages.dev/`.
That URL is constant and gets clobbered by each deploy (no stable history).
Because the origin never changes, browser localStorage (the OpenRouter login
in the Copilot) persists there across deploys — use that URL for manual
testing instead of a per-branch URL, which requires re-logging in each time.

## Repo map

- `frontend/` — Vite + React UI (Copilot, market screener, research, SQL lab,
  monitor, docs portal).
- `worker/` — Cloudflare Worker backend: Iceberg lake over R2 SQL → JSON
  (`/api/*`), plus the `/loader/*` pass-through.
- `loader/` — CBOE → Cloudflare Pipelines → R2 Data Catalog ingestion
  (`cboe-to-r2`): continuous Durable Object scheduler, OHLC jobs, D1 state.
- Root `README.md` — architecture, full API reference, run/deploy
  instructions; deeper docs exist as `PLAN-*.md` / `WORKER-*.md` at the root.