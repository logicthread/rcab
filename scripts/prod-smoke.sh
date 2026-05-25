#!/usr/bin/env bash
set -euo pipefail

URL="${PROD_SMOKE_URL:-https://localhost/v1/health/ready}"
TIMEOUT="${PROD_SMOKE_TIMEOUT:-90}"
INTERVAL=2
HOST_HEADER="${PROD_SMOKE_HOST:-api.rcab.example}"

elapsed=0
while (( elapsed < TIMEOUT )); do
  status="$(curl -sk -H "Host: ${HOST_HEADER}" -o /dev/null -w '%{http_code}' "${URL}" 2>/dev/null || echo '000')"
  if [[ "${status}" == "200" ]]; then
    echo "[prod-smoke] ready after ${elapsed}s"
    exit 0
  fi
  sleep "${INTERVAL}"
  elapsed=$(( elapsed + INTERVAL ))
done

echo "[prod-smoke] timed out after ${TIMEOUT}s (last status: ${status})"
docker compose -f infra/docker/docker-compose.prod.yml -f infra/docker/docker-compose.prod-test.yml logs --tail=50
exit 1
