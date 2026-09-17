#!/usr/bin/env bash
# Isolated tests for sync-screener-secrets.sh (mock npx; no Cloudflare).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/sync-screener-secrets.sh"
PASS=0
FAIL=0

assert_eq() {
  local got="$1" want="$2" msg="$3"
  if [[ "$got" == "$want" ]]; then
    echo "ok  $msg"
    PASS=$((PASS + 1))
  else
    echo "FAIL $msg (got ${got@Q}, want ${want@Q})" >&2
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local hay="$1" needle="$2" msg="$3"
  if [[ "$hay" == *"$needle"* ]]; then
    echo "ok  $msg"
    PASS=$((PASS + 1))
  else
    echo "FAIL $msg (missing ${needle@Q} in ${hay@Q})" >&2
    FAIL=$((FAIL + 1))
  fi
}

run_sync() {
  local mock_dir="$1"
  shift
  env -i \
    PATH="$mock_dir:/usr/bin:/bin" \
    HOME="$HOME" \
    SYNC_SCREENER_SECRET_RETRIES="${SYNC_SCREENER_SECRET_RETRIES:-4}" \
    SYNC_SCREENER_SECRET_RETRY_DELAY="${SYNC_SCREENER_SECRET_RETRY_DELAY:-0}" \
    MOCK_DIR="$mock_dir" \
    "$@" \
    bash "$SCRIPT" "${WORKER_NAME:-screener-api}"
}

setup_mock() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != wrangler || "${2:-}" != secret || "${3:-}" != put ]]; then
  echo "unexpected: $*" >&2
  exit 2
fi
name="$4"
worker="$6"
value=$(cat)
mkdir -p "$MOCK_DIR/puts"
printf '%s\t%s\t%s\n' "$name" "$worker" "$value" >>"$MOCK_DIR/puts/log"
count_file="$MOCK_DIR/puts/count-$name"
n=0
[[ -f "$count_file" ]] && n=$(cat "$count_file")
n=$((n + 1))
printf '%s\n' "$n" >"$count_file"
fail_n="${FAIL_UNTIL:-0}"
if [[ "$n" -le "$fail_n" ]]; then
  echo "simulated 503 for $name attempt $n" >&2
  exit 1
fi
echo "put $name on $worker"
exit 0
EOF
  chmod +x "$dir/npx"
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# 1. Missing worker name
set +e
out=$(env -i PATH="/usr/bin:/bin" bash "$SCRIPT" 2>&1)
status=$?
set -e
assert_eq "$status" "1" "missing worker name exits 1"
assert_contains "$out" "worker name" "missing worker name prints usage"

# 2. All unset → skip, no puts, exit 0
mock="$WORKDIR/skip"
setup_mock "$mock"
set +e
out=$(run_sync "$mock" 2>&1)
status=$?
set -e
assert_eq "$status" "0" "all-unset exits 0"
assert_contains "$out" "TAVILY_API_KEY not set" "skips unset TAVILY_API_KEY"
assert_contains "$out" "BETTER_AUTH_SECRET not set" "skips unset BETTER_AUTH_SECRET"
if [[ -f "$mock/puts/log" ]]; then
  echo "FAIL skip case wrote puts" >&2
  FAIL=$((FAIL + 1))
else
  echo "ok  skip case writes no puts"
  PASS=$((PASS + 1))
fi

# 3. Empty string is skipped (must not clobber)
mock="$WORKDIR/empty"
setup_mock "$mock"
set +e
out=$(run_sync "$mock" ADMIN_TOKEN="" 2>&1)
status=$?
set -e
assert_eq "$status" "0" "empty ADMIN_TOKEN exits 0"
assert_contains "$out" "ADMIN_TOKEN not set" "empty ADMIN_TOKEN is skipped"
if [[ -f "$mock/puts/log" ]]; then
  echo "FAIL empty ADMIN_TOKEN wrote a put" >&2
  FAIL=$((FAIL + 1))
else
  echo "ok  empty ADMIN_TOKEN writes no put"
  PASS=$((PASS + 1))
fi

# 4. Set vars are put with exact stdin (no trailing newline)
mock="$WORKDIR/put"
setup_mock "$mock"
set +e
out=$(run_sync "$mock" ADMIN_TOKEN="tok-no-nl" LOADER_TOKEN="loader/ok" R2_DATA_CATALOG_TOKEN="cat-tok" 2>&1)
status=$?
set -e
assert_eq "$status" "0" "set secrets exit 0"
log=$(cat "$mock/puts/log")
assert_contains "$log" $'ADMIN_TOKEN\tscreener-api\ttok-no-nl' "ADMIN_TOKEN put with exact value"
assert_contains "$log" $'LOADER_TOKEN\tscreener-api\tloader/ok' "LOADER_TOKEN put with exact value"
assert_contains "$log" $'R2_DATA_CATALOG_TOKEN\tscreener-api\tcat-tok' "R2_DATA_CATALOG_TOKEN put with exact value"
assert_eq "$(grep -c $'^TAVILY' "$mock/puts/log" || true)" "0" "unset TAVILY is not put"

# 5. Retry: fail twice, succeed on third
mock="$WORKDIR/retry"
setup_mock "$mock"
set +e
out=$(FAIL_UNTIL=2 run_sync "$mock" FAIL_UNTIL=2 ADMIN_TOKEN="after-503" 2>&1)
status=$?
set -e
assert_eq "$status" "0" "retry then success exits 0"
assert_eq "$(cat "$mock/puts/count-ADMIN_TOKEN")" "3" "retried until third attempt"
assert_contains "$out" "attempt 1/4" "logged first retry"
assert_contains "$out" "attempt 2/4" "logged second retry"

# 6. Exhausted retries fail that name but still attempt the next
mock="$WORKDIR/exhaust"
setup_mock "$mock"
set +e
out=$(FAIL_UNTIL=99 run_sync "$mock" FAIL_UNTIL=99 ADMIN_TOKEN="nope" LOADER_TOKEN="also" 2>&1)
status=$?
set -e
assert_eq "$status" "1" "exhausted retries exit 1"
assert_eq "$(cat "$mock/puts/count-ADMIN_TOKEN")" "4" "ADMIN_TOKEN attempted 4 times"
assert_eq "$(cat "$mock/puts/count-LOADER_TOKEN")" "4" "LOADER_TOKEN still attempted after ADMIN_TOKEN failed"

# 7. Preview worker name is forwarded
mock="$WORKDIR/dev"
setup_mock "$mock"
set +e
out=$(WORKER_NAME=screener-api-dev run_sync "$mock" WORKER_NAME=screener-api-dev OPEN_ROUTER_KEY="or" 2>&1)
status=$?
set -e
assert_eq "$status" "0" "preview worker exits 0"
assert_contains "$(cat "$mock/puts/log")" $'OPEN_ROUTER_KEY\tscreener-api-dev\tor' "put uses screener-api-dev"

echo
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
