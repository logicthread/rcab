#!/usr/bin/env bash
# build-images.sh — build the API and web images ONCE for a commit (RCAB-E8.S11).
#
#   scripts/deploy/build-images.sh --version <commit-sha> [--registry ghcr.io/logicthread]
#
# Produces <registry>/rcab-api:<sha> and <registry>/rcab-web:<sha>, each carrying
# the build identity as build args (served by GET /v1/health/version and
# /version.json) and as the org.opencontainers.image.revision label. Deliberately
# no `latest` tag: the only way to refer to a release is its SHA.
#
# The web image inlines the public browser config at build time. Set in the
# environment (the Dockerfile fails the build if a required one is empty):
#   NEXT_PUBLIC_API_URL                                  always required
#   WEB_AUTH_PHONE_ENABLED=true                          only once phone OTP is re-enabled; then
#     NEXT_PUBLIC_FIREBASE_API_KEY / _AUTH_DOMAIN / _PROJECT_ID / _APP_ID become required
#   [NEXT_PUBLIC_GOOGLE_CLIENT_ID] [NEXT_PUBLIC_NOMINATIM_URL]   optional
# Sign-in is Google-only until launch (RCAB-E8.S15): the browser reads the Google client
# id from the API (GET /v1/auth/config), so NEXT_PUBLIC_GOOGLE_CLIENT_ID is only a fallback.
# This script never pushes; the Jenkinsfile does that in its own credentialed stage.
set -euo pipefail

VERSION=""; REGISTRY="${RCAB_REGISTRY:-ghcr.io/logicthread}"
while (( $# )); do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --registry) REGISTRY="${2:-}"; shift 2 ;;
    *) echo "usage: build-images.sh --version <sha> [--registry R]" >&2; exit 2 ;;
  esac
done
[[ "${VERSION}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || { echo "[build-images] --version must be a valid image tag" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "[build-images] api ${REGISTRY}/rcab-api:${VERSION}"
docker build \
  -f infra/docker/api/Dockerfile.prod \
  --build-arg "RCAB_VERSION=${VERSION}" \
  --build-arg "RCAB_BUILT_AT=${BUILT_AT}" \
  -t "${REGISTRY}/rcab-api:${VERSION}" \
  .

echo "[build-images] web ${REGISTRY}/rcab-web:${VERSION}"
docker build \
  -f infra/docker/web/Dockerfile.prod \
  --build-arg "RCAB_VERSION=${VERSION}" \
  --build-arg "RCAB_BUILT_AT=${BUILT_AT}" \
  --build-arg "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL:-}" \
  --build-arg "WEB_AUTH_PHONE_ENABLED=${WEB_AUTH_PHONE_ENABLED:-false}" \
  --build-arg "NEXT_PUBLIC_GOOGLE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_CLIENT_ID:-}" \
  --build-arg "NEXT_PUBLIC_FIREBASE_API_KEY=${NEXT_PUBLIC_FIREBASE_API_KEY:-}" \
  --build-arg "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:-}" \
  --build-arg "NEXT_PUBLIC_FIREBASE_PROJECT_ID=${NEXT_PUBLIC_FIREBASE_PROJECT_ID:-}" \
  --build-arg "NEXT_PUBLIC_FIREBASE_APP_ID=${NEXT_PUBLIC_FIREBASE_APP_ID:-}" \
  --build-arg "NEXT_PUBLIC_NOMINATIM_URL=${NEXT_PUBLIC_NOMINATIM_URL:-https://nominatim.openstreetmap.org}" \
  -t "${REGISTRY}/rcab-web:${VERSION}" \
  .

echo "[build-images] done: ${REGISTRY}/rcab-{api,web}:${VERSION} built at ${BUILT_AT}"
