#!/usr/bin/env bash
# Sync GitHub Actions secrets onto a Cloudflare Worker.
#
# Worker `wrangler deploy` preserves existing secrets. This script is a
# post-publish sync so rotating a GitHub secret still updates the Worker.
# Transient Cloudflare 503s on PUT /secrets must not block that deploy —
# retry each put (default 4 attempts, 4s/8s/16s/32s). Empty env values are
# skipped so a missing GitHub secret never clobbers a live Worker secret.
# A failed put does not skip the remaining names.
#
# Usage (cwd: worker/, value in the env var of the same name):
#   bash ../.github/scripts/sync-screener-secrets.sh <worker-name>
set -euo pipefail

WORKER="${1:?worker name (screener-api or screener-api-dev)}"
RETRIES="${SYNC_SCREENER_SECRET_RETRIES:-4}"
INITIAL_DELAY="${SYNC_SCREENER_SECRET_RETRY_DELAY:-4}"

NAMES=(
  TAVILY_API_KEY
  FRED_API_KEY
  OPEN_ROUTER_KEY
  ADMIN_TOKEN
  LOADER_TOKEN
  IMPROVEMENT_ISSUE_TOKEN
  BETTER_AUTH_SECRET
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  SCHWAB_CLIENT_ID
  SCHWAB_CLIENT_SECRET
)

put_one() {
  local name="$1"
  local value="$2"
  local attempt=0
  local delay="$INITIAL_DELAY"
  while [ "$attempt" -lt "$RETRIES" ]; do
    attempt=$((attempt + 1))
    if printf '%s' "$value" | npx wrangler secret put "$name" --name "$WORKER"; then
      return 0
    fi
    echo "wrangler secret put ${name} → ${WORKER} failed (attempt ${attempt}/${RETRIES})" >&2
    if [ "$attempt" -ge "$RETRIES" ]; then
      return 1
    fi
    sleep "$delay"
    delay=$((delay * 2))
  done
}

failed=0
for name in "${NAMES[@]}"; do
  if [[ ! -v "$name" ]] || [[ -z "${!name}" ]]; then
    echo "${name} not set — skipping (existing Worker secret left intact)"
    continue
  fi
  if ! put_one "$name" "${!name}"; then
    echo "${name} failed after ${RETRIES} attempts" >&2
    failed=1
  fi
done
exit "$failed"
