#!/usr/bin/env bash
# Smoke-test a running Sharebox worker (default: wrangler dev on :8787).
# Usage: scripts/smoke.sh [base_url] [email] [password]
# Registers the owner if none exists yet, otherwise logs in.
set -euo pipefail
BASE="${1:-http://localhost:8787}/api"
EMAIL="${2:-me@example.com}"
PASS="${3:-hunter2hunter2}"
CT='Content-Type: application/json'
pass=0; failn=0
check() { # name expected_code actual_code body
  if [[ "$3" == "$2" ]]; then pass=$((pass+1)); echo "ok   $1 [$3]"; else failn=$((failn+1)); echo "FAIL $1 expected $2 got $3: $4"; fi
}
req() { # method path [data] -> sets CODE and BODY
  local out
  out=$(curl -s -w $'\n%{http_code}' -X "$1" -H "$CT" ${TOKEN:+-H "Authorization: Bearer $TOKEN"} ${3:+-d "$3"} "$BASE$2")
  CODE="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
json() { python3 -c "import sys,json; d=json.loads(sys.argv[1]); print($2)" "$1"; }

TOKEN=""
req GET /health; check health 200 "$CODE" "$BODY"
req GET /collections; check "no token -> 401" 401 "$CODE" "$BODY"

req POST /auth/register "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"displayName\":\"Me\"}"
if [[ "$CODE" == 201 ]]; then echo "ok   registered owner"; else check "register (owner exists)" 403 "$CODE" "$BODY"; fi
req POST /auth/register '{"email":"intruder@example.com","password":"whatever123"}'
check "second register -> 403" 403 "$CODE" "$BODY"
req POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"wrong-password\"}"
check "bad login -> 401" 401 "$CODE" "$BODY"
req POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"
check login 200 "$CODE" "$BODY"
TOKEN=$(json "$BODY" 'd["token"]')

req POST /collections '{"name":"Smoke test"}'
check "create collection" 201 "$CODE" "$BODY"
CID=$(json "$BODY" 'd["id"]')
req GET /collections
check "list collections" 200 "$CODE" "$BODY"
echo "     collections: $(json "$BODY" '[c["name"] for c in d]')"
req DELETE /collections/uncategorized
check "delete Uncategorized -> 409" 409 "$CODE" "$BODY"

req GET "/sync/pull?since=0"; SEQ0=$(json "$BODY" 'd["serverMaxSeq"]')
NOW=$(date -u +%FT%TZ); IID="smoke-$(date +%s%N)"
HLC=$(printf '%013d-0001-smoke' "$(date +%s%3N)")
row() { echo "{\"id\":\"$IID\",\"collection_id\":\"$CID\",\"subject\":\"$1\",\"kind\":\"text\",\"content\":\"smoke content\",\"tags\":[\"t\"],\"notes\":\"\",\"created_at\":\"$NOW\",\"updated_at\":\"$NOW\",\"deleted_at\":null,\"hlc\":\"$2\"}"; }
req POST /sync/push "{\"actor\":\"smoke\",\"ops\":[{\"entity\":\"items\",\"row\":$(row Fresh "$HLC")},{\"entity\":\"items\",\"row\":{\"id\":\"broken\"}}]}"
check "push" 200 "$CODE" "$BODY"
check "push: valid op accepted, invalid rejected" "True False" "$(json "$BODY" '" ".join(str(r["accepted"]) for r in d["results"])')" "$BODY"
req POST /sync/push "{\"ops\":[{\"entity\":\"items\",\"row\":$(row Stale 0000000000001-0000-old)}]}"
check "push: older hlc loses (LWW)" False "$(json "$BODY" 'd["results"][0]["accepted"]')" "$BODY"
req GET "/sync/pull?since=$SEQ0"
check "pull since previous max returns exactly the accepted op" "1 $IID Fresh" "$(json "$BODY" '" ".join([str(len(d["ops"])), d["ops"][0]["row"]["id"], d["ops"][0]["row"]["subject"]])')" "$BODY"

req PATCH "/items/$IID" '{"notes":"edited via REST"}'
check "patch item" 200 "$CODE" "$BODY"
req GET "/items?q=smoke"
check "search items" 200 "$CODE" "$BODY"
req DELETE "/items/$IID"; check "delete item" 204 "$CODE" "$BODY"
req GET "/items/$IID"; check "deleted item -> 404" 404 "$CODE" "$BODY"
req DELETE "/collections/$CID"; check "delete collection" 204 "$CODE" "$BODY"

echo "$pass passed, $failn failed"
[[ $failn == 0 ]]
