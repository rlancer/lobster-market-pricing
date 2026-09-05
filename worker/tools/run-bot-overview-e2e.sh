#!/usr/bin/env bash
# Headless overview e2e against api-dev. Never prints ADMIN_TOKEN.
# Registers each share on an admin QA batch so the runs stay off the Floor.
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
export QA_TITLE=${QA_TITLE:-"@${HANDLE} overview tape"}
export QA_DESCRIPTION=${QA_DESCRIPTION:-Assert get_market_tape and no unfiltered option_contracts GROUP BY (portfolio schema leak).}
export QA_PR_URL=${QA_PR_URL:-https://github.com/rlancer/lobster-market-pricing/pull/328}
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

if [ -z "${QA_BATCH_ID:-}" ]; then
  python3 - <<PY
import json, os
open("/tmp/qa-batch.json", "w").write(json.dumps({
    "title": os.environ["QA_TITLE"],
    "description": os.environ["QA_DESCRIPTION"],
    "pr_url": os.environ["QA_PR_URL"],
}))
PY
  qa_http=$(curl -sS -o /tmp/qa.json -w '%{http_code}' \
    -X POST "${AUTH[@]}" --data-binary @/tmp/qa-batch.json \
    "$API_BASE/api/admin/qa")
  echo "POST /api/admin/qa HTTP $qa_http"
  python3 - <<'PY'
import json, sys
body = json.load(open("/tmp/qa.json"))
print("qa_batch", {k: body.get("batch", {}).get(k) if isinstance(body.get("batch"), dict) else body.get(k)
                   for k in ("ok", "error", "batch_id", "title")})
if not (body.get("ok") and body.get("batch", {}).get("batch_id")):
    raise SystemExit("could not create qa batch")
open("/tmp/qa-batch-id.txt", "w").write(body["batch"]["batch_id"])
PY
  if [ "$qa_http" != "200" ]; then
    echo "::error::could not create qa batch"
    exit 1
  fi
  QA_BATCH_ID=$(cat /tmp/qa-batch-id.txt)
fi
export QA_BATCH_ID
echo "qa_batch_id=$QA_BATCH_ID title=$QA_TITLE"

mkdir -p /tmp/overview-e2e
fail=0
for i in $(seq 1 "$COUNT"); do
  echo "::group::run $i / $COUNT"
  python3 - <<PY
import json, os
open("/tmp/trigger-body.json", "w").write(json.dumps({
    "list_on_floor": False,
    "qa_batch_id": os.environ["QA_BATCH_ID"],
}))
PY
  attempt=0
  while [ "$attempt" -lt 8 ]; do
    attempt=$((attempt + 1))
    http=$(curl -sS --max-time 600 -o /tmp/trigger.json -w '%{http_code}' \
      -X POST "${AUTH[@]}" --data-binary @/tmp/trigger-body.json \
      "$API_BASE/api/admin/bots/$HANDLE/schedule/trigger?force=1")
    echo "trigger HTTP $http attempt=$attempt"
    python3 - <<'PY'
import json
body = json.load(open("/tmp/trigger.json"))
print("trigger", {k: body.get(k) for k in (
    "ok", "error", "run_id", "chat_id", "share_id", "deferred", "reason",
    "list_on_floor", "qa_batch_id", "qa_item_id",
)})
PY
    if [ "$http" = "200" ] && python3 -c 'import json,sys; b=json.load(open("/tmp/trigger.json")); sys.exit(0 if b.get("ok") and b.get("share_id") else 1)'; then
      listed=$(python3 -c 'import json; print(json.load(open("/tmp/trigger.json")).get("list_on_floor"))')
      if [ "$listed" = "True" ] || [ "$listed" = "true" ]; then
        echo "::error::trigger listed the share on the Floor"
        fail=1
        break
      fi
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
  qa_item_id=$(python3 -c 'import json; print(json.load(open("/tmp/trigger.json")).get("qa_item_id") or "")')
  echo "share https://dev.lobster.mp/share/$share_id (unlisted)"
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
  if (cd "$ROOT" && node --import tsx tools/assert-bot-overview-e2e.ts \
    "/tmp/overview-e2e/trigger-$i.json" "/tmp/overview-e2e/tools-$i.json"); then
    verdict=true
  else
    echo "::error::overview assertions failed for run $i share=$share_id"
    fail=1
    verdict=false
  fi
  if [ -n "$qa_item_id" ]; then
    VERDICT=$verdict SHARE_ID=$share_id python3 - <<'PY'
import json, os
open("/tmp/verdict.json", "w").write(json.dumps({
    "verdict_ok": os.environ["VERDICT"] == "true",
    "verdict": {"assert": "get_market_tape", "share_id": os.environ["SHARE_ID"]},
}))
PY
    curl -sS -o /tmp/verdict-res.json -w 'PATCH verdict HTTP %{http_code}\n' \
      -X PATCH "${AUTH[@]}" --data-binary @/tmp/verdict.json \
      "$API_BASE/api/admin/qa/items/$qa_item_id"
  fi
  echo "::endgroup::"
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "all $COUNT overview run(s) called get_market_tape, skipped the leak SQL, and stayed off the Floor"
echo "qa_batch_id=$QA_BATCH_ID"
