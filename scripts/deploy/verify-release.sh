#!/usr/bin/env bash
# verify-release.sh — assert that the stack at a REAL target is healthy AND runs
# the release we just deployed (RCAB-E8.S11, finding F14).
#
# Probes (all over the network, never the local Docker daemon):
#   GET <api-url>/v1/health/ready    -> 200   (postgres + redis + osrm reachable)
#   GET <api-url>/v1/health/version  -> {"version": "<expected>", ...}
#   GET <web-url>/version.json       -> {"version": "<expected>", ...}   (if --web-url)
#
# It polls until every probe passes or --timeout elapses, so it tolerates the
# window where the old containers still answer. A version mismatch is a FAILURE,
# not a warning: a green /ready from the previous release must not pass.
#
# Exit: 0 verified | 1 not healthy / wrong version at timeout | 2 usage error.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: verify-release.sh --api-url URL --expect-version VERSION
                         [--web-url URL] [--host-header HOST] [--web-host-header HOST]
                         [--insecure] [--timeout SECONDS] [--interval SECONDS]

  --api-url URL          API origin, e.g. https://api.example.com (no trailing path)
  --expect-version V     commit SHA / tag that must be reported by the running build
  --web-url URL          also assert the web image's /version.json
  --host-header HOST     send "Host: HOST" to the API (target addressed by IP)
  --web-host-header HOST send "Host: HOST" to the web origin
  --insecure             accept a self-signed certificate (local/CI prod-test ONLY)
  --timeout SECONDS      overall budget (default 120)
USAGE
  exit 2
}

API_URL=""; WEB_URL=""; EXPECT=""; API_HOST=""; WEB_HOST=""; INSECURE=0; TIMEOUT=120; INTERVAL=3
while (( $# )); do
  case "$1" in
    --api-url) API_URL="${2:-}"; shift 2 ;;
    --web-url) WEB_URL="${2:-}"; shift 2 ;;
    --expect-version) EXPECT="${2:-}"; shift 2 ;;
    --host-header) API_HOST="${2:-}"; shift 2 ;;
    --web-host-header) WEB_HOST="${2:-}"; shift 2 ;;
    --insecure) INSECURE=1; shift ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "[verify-release] unknown argument: $1" >&2; usage ;;
  esac
done
[[ -n "${API_URL}" ]] || { echo "[verify-release] --api-url is required (no default target)" >&2; usage; }
[[ -n "${EXPECT}" ]] || { echo "[verify-release] --expect-version is required" >&2; usage; }
API_URL="${API_URL%/}"; WEB_URL="${WEB_URL%/}"

curl_base=(-sS --max-time 5)
if (( INSECURE )); then curl_base+=(-k); fi

# get <url> [host-header] -> prints "<body>\n<status>"; never fails the script.
get() {
  local url="$1" host="${2:-}" out
  local extra=()
  if [[ -n "${host}" ]]; then extra=(-H "Host: ${host}"); fi
  out="$(curl "${curl_base[@]}" ${extra[@]+"${extra[@]}"} -w '\n%{http_code}' "${url}" 2>/dev/null)" || out=$'\n000'
  printf '%s' "${out}"
}

json_version() { sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1; }

LAST="no probe ran"
check_once() {
  local resp status body ver
  resp="$(get "${API_URL}/v1/health/ready" "${API_HOST}")"
  status="${resp##*$'\n'}"
  if [[ "${status}" != "200" ]]; then LAST="api /v1/health/ready -> ${status}"; return 1; fi

  resp="$(get "${API_URL}/v1/health/version" "${API_HOST}")"
  status="${resp##*$'\n'}"; body="${resp%$'\n'*}"
  if [[ "${status}" != "200" ]]; then LAST="api /v1/health/version -> ${status}"; return 1; fi
  ver="$(printf '%s' "${body}" | json_version)"
  if [[ "${ver}" != "${EXPECT}" ]]; then LAST="api version '${ver}' != expected '${EXPECT}'"; return 1; fi

  if [[ -n "${WEB_URL}" ]]; then
    resp="$(get "${WEB_URL}/version.json" "${WEB_HOST}")"
    status="${resp##*$'\n'}"; body="${resp%$'\n'*}"
    if [[ "${status}" != "200" ]]; then LAST="web /version.json -> ${status}"; return 1; fi
    ver="$(printf '%s' "${body}" | json_version)"
    if [[ "${ver}" != "${EXPECT}" ]]; then LAST="web version '${ver}' != expected '${EXPECT}'"; return 1; fi
  fi
  return 0
}

echo "[verify-release] target api=${API_URL}${WEB_URL:+ web=${WEB_URL}} expect=${EXPECT} timeout=${TIMEOUT}s"
elapsed=0
while :; do
  if check_once; then
    echo "[verify-release] OK: ready and running version ${EXPECT} after ${elapsed}s"
    exit 0
  fi
  (( elapsed < TIMEOUT )) || break
  sleep "${INTERVAL}"
  elapsed=$(( elapsed + INTERVAL ))
done
echo "[verify-release] FAIL after ${TIMEOUT}s: ${LAST}" >&2
exit 1
