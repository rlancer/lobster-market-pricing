#!/usr/bin/env bash
# Create an isolated My Machines / remote-computer worktree from origin/main.
# Usage: ./.cursor/new-remote-session.sh <slug>
# Example: ./.cursor/new-remote-session.sh portfolio-marks
set -euo pipefail

slug="${1:-}"
if [[ -z "$slug" ]]; then
  echo "usage: $0 <slug>" >&2
  echo "  slug: short kebab name for this session (no cursor/ prefix)" >&2
  exit 1
fi

# Normalize: accept "cursor/foo" or "foo"
slug="${slug#cursor/}"
slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-')"
slug="${slug#-}"
slug="${slug%-}"

if [[ -z "$slug" ]]; then
  echo "error: slug empty after normalize" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not a git repo: $root" >&2
  exit 1
fi

git fetch origin main

suffix="$(openssl rand -hex 2 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(2))')"
branch="cursor/${slug}-${suffix}"
# Sibling of the home clone so the worker dir stays outside the main checkout.
parent="$(dirname "$root")"
home_name="$(basename "$root")"
worktree="${parent}/${home_name}-${branch//\//-}"

if [[ -e "$worktree" ]]; then
  echo "error: worktree path already exists: $worktree" >&2
  exit 1
fi

git worktree add "$worktree" -b "$branch" origin/main

# Best-effort secret copy (same paths as .cursor/worktrees.json).
copy_if() {
  local src="$1" dst="$2"
  if [[ -f "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
  fi
}
copy_if "$root/.env" "$worktree/.env"
copy_if "$root/frontend/.env" "$worktree/frontend/.env"
copy_if "$root/worker/.dev.vars" "$worktree/worker/.dev.vars"
copy_if "$root/loader/.env" "$worktree/loader/.env"

echo
echo "Session ready:"
echo "  branch:   $branch"
echo "  worktree: $worktree"
echo
echo "Start (or retarget) the My Machines worker in that checkout:"
echo "  agent worker start --worker-dir \"$worktree\" --name \"$branch\""
echo
echo "Keep the home clone on main; do not leave it on cursor/* branches."
