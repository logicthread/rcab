#!/usr/bin/env bash
# Production smoke: probe an EXPLICIT target and assert the running build version.
# RCAB-E8.S11 (F14): there is deliberately no localhost default — a smoke that
# silently hits the CI executor proves nothing about the VPS.
#
#   PROD_SMOKE_URL             (required) API origin, e.g. https://api.example.com
#   PROD_SMOKE_EXPECT_VERSION  (required) commit SHA the target must report
#   PROD_SMOKE_WEB_URL         (optional) also assert <web>/version.json
#   PROD_SMOKE_HOST            (optional) Host header for the API (target addressed by IP)
#   PROD_SMOKE_WEB_HOST        (optional) Host header for the web origin
#   PROD_SMOKE_TIMEOUT         (optional) seconds, default 90
#   PROD_SMOKE_INSECURE=1      (local prod-test only) accept the self-signed cert
#   PROD_SMOKE_COMPOSE_LOGS=1  (local prod-test only) dump compose logs on failure
#
# `pnpm prod:smoke` sets the local prod-test values explicitly; CI/CD calls
# scripts/deploy/verify-release.sh (via deploy.sh) with the real VPS URL.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${PROD_SMOKE_URL:-}" ]]; then
  echo "[prod-smoke] PROD_SMOKE_URL is required (no default target)" >&2
  exit 2
fi
if [[ -z "${PROD_SMOKE_EXPECT_VERSION:-}" ]]; then
  echo "[prod-smoke] PROD_SMOKE_EXPECT_VERSION is required (the commit SHA that must be running)" >&2
  exit 2
fi

args=(--api-url "${PROD_SMOKE_URL}" --expect-version "${PROD_SMOKE_EXPECT_VERSION}" --timeout "${PROD_SMOKE_TIMEOUT:-90}")
if [[ -n "${PROD_SMOKE_WEB_URL:-}" ]]; then args+=(--web-url "${PROD_SMOKE_WEB_URL}"); fi
if [[ -n "${PROD_SMOKE_HOST:-}" ]]; then args+=(--host-header "${PROD_SMOKE_HOST}"); fi
if [[ -n "${PROD_SMOKE_WEB_HOST:-}" ]]; then args+=(--web-host-header "${PROD_SMOKE_WEB_HOST}"); fi
if [[ "${PROD_SMOKE_INSECURE:-0}" == "1" ]]; then args+=(--insecure); fi

if bash "${REPO_ROOT}/scripts/deploy/verify-release.sh" "${args[@]}"; then
  exit 0
fi

if [[ "${PROD_SMOKE_COMPOSE_LOGS:-0}" == "1" ]]; then
  RCAB_VERSION="${PROD_SMOKE_EXPECT_VERSION}" docker compose \
    -f "${REPO_ROOT}/infra/docker/docker-compose.prod.yml" \
    -f "${REPO_ROOT}/infra/docker/docker-compose.prod-test.yml" logs --tail=50 || true
fi
exit 1
