#!/usr/bin/env bash
# Headless overview e2e against api-dev. Never prints ADMIN_TOKEN.
set -euo pipefail

if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "::error::ADMIN_TOKEN is not set"
  exit 1
fi

HANDLE=$(printf '%s' "${HANDLE:-nowlobster}" | tr -d '@' | tr '[:upper:]' '[:lower:]')
COUNT=$(printf '%s' "${COUNT:-3}" | tr -cd '0-9')
if [ -z "$COUNT" ] || [ "$COUNT" -lt 1 ]; then COUNT=1; fi
if [ "$COUNT" -gt 5 ]; then COUNT=5; fi
API_BASE=${API_BASE:-https://api-dev.lobster.mp}
API_BASE=${API_BASE%/}
AUTH=(
  -H "Authorization: Bearer $ADMIN_TOKEN"
  -H "Content-Type: application/json"
  -H "User-Agent: Mozilla/5.0 (compatible; lobster-overview-e2e/1.0)"
  -H "Accept: application/json"
)
ROOT=$(cd "$(dirname "$0")/.." && pwd)

echo "handle=$HANDLE count=$COUNT api=$API_BASE"

sched=$(curl -sS -o /tmp/bot.json -w '%{http_code}' "${AUTH[@]}" \
  "$API_BASE/api/admin/bots/$HANDLE")
echo "GET /api/admin/bots/$HANDLE HTTP $sched"
python3 - <<'PY'
import json
body = json.load(open("/tmp/bot.json"))
bot = body.get("bot") or {}
schedule = body.get("schedule")
print("bot", bot.get("handle"), "enabled", bot.get("enabled"), "has_schedule", bool(schedule))
if not bot.get("enabled"):
    raise SystemExit("bot missing or disabled")
if not schedule:
    raise SystemExit("bot has no schedule — cannot headless-trigger")
print("schedule_prompt", (schedule.get("prompt") or "")[:180])
PY
if [ "$sched" != "200" ]; then
  echo "::error::could not load bot $HANDLE"
  exit 1
fi

mkdir -p /tmp/overview-e2e
fail=0
for i in $(seq 1 "$COUNT"); do
  echo "::group::run $i / $COUNT"
  attempt=0
  while [ "$attempt" -lt 8 ]; do
    attempt=$((attempt + 1))
    http=$(curl -sS --max-time 600 -o /tmp/trigger.json -w '%{http_code}' \
      -X POST "${AUTH[@]}" \
      "$API_BASE/api/admin/bots/$HANDLE/schedule/trigger?force=1")
    echo "trigger HTTP $http attempt=$attempt"
    python3 - <<'PY'
import json
body = json.load(open("/tmp/trigger.json"))
print("trigger", {k: body.get(k) for k in ("ok", "error", "run_id", "chat_id", "share_id", "deferred", "reason")})
PY
    if [ "$http" = "200" ] && python3 -c 'import json,sys; b=json.load(open("/tmp/trigger.json")); sys.exit(0 if b.get("ok") and b.get("share_id") else 1)'; then
      break
    fi
    err=$(python3 -c 'import json; print((json.load(open("/tmp/trigger.json")).get("error") or ""))')
    case "$err" in
      *"in progress"*|*"code was updated"*|*"Durable Object reset"*)
        echo "transient: $err — wait 30s"
        sleep 30
        ;;
      *) echo "::error::trigger failed: $err"; fail=1; break ;;
    esac
  done
  if [ "$fail" -ne 0 ]; then
    echo "::endgroup::"
    break
  fi
  share_id=$(python3 -c 'import json; print(json.load(open("/tmp/trigger.json")).get("share_id") or "")')
  echo "share https://dev.lobster.mp/share/$share_id"
  echo "share https://lobster.mp/share/$share_id"
  tools_http=$(curl -sS -o /tmp/tools.json -w '%{http_code}' \
    -H "User-Agent: Mozilla/5.0 (compatible; lobster-overview-e2e/1.0)" \
    -H "Accept: application/json" \
    "$API_BASE/api/tool_calls?share_id=${share_id}&ok=all&limit=100")
  echo "GET /api/tool_calls HTTP $tools_http"
  if [ "$tools_http" != "200" ]; then
    echo "::error::tool_calls fetch failed"
    fail=1
    echo "::endgroup::"
    break
  fi
  cp /tmp/trigger.json "/tmp/overview-e2e/trigger-$i.json"
  cp /tmp/tools.json "/tmp/overview-e2e/tools-$i.json"
  if ! (cd "$ROOT" && node --import tsx tools/assert-bot-overview-e2e.ts \
    "/tmp/overview-e2e/trigger-$i.json" "/tmp/overview-e2e/tools-$i.json"); then
    echo "::error::overview assertions failed for run $i share=$share_id"
    fail=1
  fi
  echo "::endgroup::"
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "all $COUNT overview run(s) called get_market_tape and skipped the leak SQL"
