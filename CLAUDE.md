# CLAUDE

Repo-wide agent contract: **[`AGENTS.md`](./AGENTS.md)** (read that first).
Package rules: `frontend/AGENTS.md`, `loader/AGENTS.md`.

## Force a loader job when you lack `LOADER_TOKEN` locally

`LOADER_TOKEN` is usually **not** in local `.env` — only in GitHub Actions
secrets + the Worker. You cannot read GitHub secret values back. Do **not**
block on pasting it; dispatch a workflow that already has the secret:

```bash
# Kalshi hourly pass (async + poll — preferred)
gh workflow run "Provision Kalshi markets pipeline" --ref <branch-with-workflow>
gh run watch   # or open the Actions URL from the create output

# Other jobs (sync force; see workflow choice list)
gh workflow run "Force loader pass (market-closed override)" -f job=<job-id>
```

Kalshi PEM upload (desktop, after keys are in `.env`):  
`cd loader && node tools/put_kalshi_secrets.mjs --deploy`  
Details and gotchas: `AGENTS.md` → Operational gotchas.
