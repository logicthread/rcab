#!/usr/bin/env bash
set -euo pipefail

PROM_URL="${PROM_URL:-http://localhost:9090}"
API_URL="${API_URL:-http://localhost:3000}"
TIMEOUT="${OBS_SMOKE_TIMEOUT:-60}"
INTERVAL=5

echo "[obs-smoke] generating traffic against ${API_URL}"
curl -sf "${API_URL}/v1/health/live" > /dev/null || true
curl -sf "${API_URL}/v1/health/live" > /dev/null || true
curl -sf "${API_URL}/v1/health/ready" > /dev/null || true

echo "[obs-smoke] waiting for Prometheus to scrape..."
elapsed=0
while (( elapsed < TIMEOUT )); do
  count="$(curl -sf "${PROM_URL}/api/v1/query?query=http_request_duration_seconds_count" \
    | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['result']))" 2>/dev/null || echo 0)"
  if (( count > 0 )); then
    echo "[obs-smoke] Prometheus has http_request_duration_seconds_count data (${count} series)"
    exit 0
  fi
  sleep "${INTERVAL}"
  elapsed=$(( elapsed + INTERVAL ))
done

echo "[obs-smoke] FAIL: no metric data in Prometheus after ${TIMEOUT}s"
exit 1
