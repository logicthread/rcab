#!/usr/bin/env bash
set -euo pipefail

# Smoke test for the dev environment.
# Polls the api's / endpoint until it returns 200 (api is connected to postgres + redis)
# or until DEV_SMOKE_TIMEOUT seconds elapse.

URL="${DEV_SMOKE_URL:-http://localhost:3000/}"
TIMEOUT="${DEV_SMOKE_TIMEOUT:-180}"
INTERVAL="${DEV_SMOKE_INTERVAL:-2}"

echo "[smoke] polling ${URL} (timeout ${TIMEOUT}s, interval ${INTERVAL}s)"

elapsed=0
while (( elapsed < TIMEOUT )); do
  status="$(curl -s -o /tmp/dev-smoke-body -w '%{http_code}' "${URL}" || echo '000')"
  if [[ "${status}" == "200" ]]; then
    echo "[smoke] api ready"
    cat /tmp/dev-smoke-body
    echo
    exit 0
  fi
  if (( elapsed % 10 == 0 )); then
    echo "[smoke] ${elapsed}s elapsed — last status: ${status}"
    [[ -s /tmp/dev-smoke-body ]] && cat /tmp/dev-smoke-body && echo
  fi
  sleep "${INTERVAL}"
  elapsed=$(( elapsed + INTERVAL ))
done

echo "[smoke] timed out after ${TIMEOUT}s"
echo "[smoke] last response body:"
cat /tmp/dev-smoke-body || true
echo
exit 1
