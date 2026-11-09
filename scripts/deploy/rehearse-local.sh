#!/usr/bin/env bash
# rehearse-local.sh — rehearse the whole release/rollback flow against a LOCAL
# "VPS" (RCAB-E8.S11). Same deploy.sh / rollback.sh / verify-release.sh the
# pipeline uses; only the target differs (a throwaway compose project on
# 127.0.0.1:18443, no SSH, locally built images tagged rcab-local/rcab-*:<tag>).
#
#   scripts/deploy/rehearse-local.sh            # build test1/test2 if missing, run scenario, clean up
#   REHEARSE_KEEP=1 ...                         # leave the stack running afterwards
#
# Scenario (each step asserts its expected exit code; any surprise aborts):
#   1 deploy test1                      -> 0, version test1 live
#   2 deploy test2                      -> 0, previous recorded as test1
#   3 verify expecting test1            -> 1 (version assertion FAILS while test2 runs)
#   4 rollback --previous               -> 0, test1 live again
#   5 deploy "test3" (an alias of test2's image: reports test2, not test3)
#                                       -> 10 (verification failed, auto-rolled back to test1)
#   6 deploy a tag that does not exist  -> 2 (aborted before cutover, stack untouched)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"
DEPLOY="${REPO_ROOT}/scripts/deploy"
PROJECT="rcab-sim"
REGISTRY="rcab-local"
WORK="$(mktemp -d)"
ENV_FILE="${WORK}/compose.env"
INFRA="${REPO_ROOT}/infra/docker"
COMPOSE=(docker compose --project-directory "${INFRA}" --env-file "${ENV_FILE}" -p "${PROJECT}"
  -f "${INFRA}/docker-compose.prod.yml" -f "${INFRA}/docker-compose.prod-test.yml" -f "${INFRA}/docker-compose.release-sim.yml")

cleanup() {
  if [[ "${REHEARSE_KEEP:-0}" != "1" ]]; then
    RCAB_VERSION=x "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    docker rmi "${REGISTRY}/rcab-api:test3" "${REGISTRY}/rcab-web:test3" >/dev/null 2>&1 || true
  fi
  rm -rf "${WORK}"
}
trap cleanup EXIT

step() { printf '\n=== %s\n' "$*"; }
expect_rc() { # <expected> <description> -- cmd...
  local want="$1" desc="$2"; shift 3
  local rc=0
  "$@" || rc=$?
  if [[ "${rc}" != "${want}" ]]; then echo "REHEARSAL FAIL: ${desc}: exit ${rc}, wanted ${want}" >&2; exit 1; fi
  echo "ok: ${desc} (exit ${rc})"
}

# Host layer arguments + verification arguments for the simulated target.
TARGET=(--compose-dir "${INFRA}" --env-file "${ENV_FILE}" --project "${PROJECT}" --no-pull
  --compose-file docker-compose.prod.yml --compose-file docker-compose.prod-test.yml --compose-file docker-compose.release-sim.yml
  --api-url https://127.0.0.1:18443 --host-header api.rcab.example
  --web-url https://127.0.0.1:18443 --web-host-header app.rcab.example
  --insecure --timeout 90)

for t in test1 test2; do
  docker image inspect "${REGISTRY}/rcab-api:${t}" "${REGISTRY}/rcab-web:${t}" >/dev/null 2>&1 \
    || { echo "missing ${REGISTRY}/rcab-{api,web}:${t}; build with scripts/deploy/build-images.sh --version ${t} --registry ${REGISTRY}" >&2; exit 1; }
done

if [[ -z "${FIREBASE_SERVICE_ACCOUNT_JSON:-}" ]]; then
  PRIVATE_KEY="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)"
  FIREBASE_SERVICE_ACCOUNT_JSON="$(PRIVATE_KEY="${PRIVATE_KEY}" node -e '
    process.stdout.write(JSON.stringify({type:"service_account",project_id:"rcab-ci",
      client_email:"ci@rcab-ci.iam.gserviceaccount.com",private_key:process.env.PRIVATE_KEY}));')"
  export FIREBASE_SERVICE_ACCOUNT_JSON
fi

# What VPS bootstrap provides: env file + the long-lived services (postgres, redis, osrm, TLS certs).
printf 'REDIS_PASSWORD=testpass\nRCAB_REGISTRY=%s\nRCAB_VERSION=\n' "${REGISTRY}" > "${ENV_FILE}"
step "bootstrap simulated host (postgres, redis, osrm stub, self-signed certs)"
RCAB_VERSION=bootstrap "${COMPOSE[@]}" up -d --wait postgres redis osrm
RCAB_VERSION=bootstrap "${COMPOSE[@]}" up certbot

step "1. first release test1"
expect_rc 0 "deploy test1" -- bash "${DEPLOY}/deploy.sh" --version test1 "${TARGET[@]}"

step "2. second release test2"
expect_rc 0 "deploy test2" -- bash "${DEPLOY}/deploy.sh" --version test2 "${TARGET[@]}"
[[ "$(sed -n 's/^RCAB_PREVIOUS_VERSION=//p' "${ENV_FILE}")" == "test1" ]] || { echo "previous version not recorded" >&2; exit 1; }
echo "ok: env file records RCAB_VERSION=$(sed -n 's/^RCAB_VERSION=//p' "${ENV_FILE}") RCAB_PREVIOUS_VERSION=test1"

step "3. version assertion must FAIL when the wrong release is running"
expect_rc 1 "verify expecting test1 while test2 runs" -- bash "${DEPLOY}/verify-release.sh" \
  --api-url https://127.0.0.1:18443 --host-header api.rcab.example --insecure --expect-version test1 --timeout 6 --interval 2

step "4. manual rollback to the recorded previous version"
expect_rc 0 "rollback --previous" -- bash "${DEPLOY}/rollback.sh" --previous "${TARGET[@]}"

step "5. bad release (image reports another version) auto-rolls back"
docker tag "${REGISTRY}/rcab-api:test2" "${REGISTRY}/rcab-api:test3"
docker tag "${REGISTRY}/rcab-web:test2" "${REGISTRY}/rcab-web:test3"
expect_rc 10 "deploy test3 -> verification fails -> rolled back" -- bash "${DEPLOY}/deploy.sh" --version test3 "${TARGET[@]}" --timeout 20
expect_rc 0 "test1 is serving after the automatic rollback" -- bash "${DEPLOY}/verify-release.sh" \
  --api-url https://127.0.0.1:18443 --host-header api.rcab.example --insecure --expect-version test1 --timeout 30

step "6. release whose image does not exist aborts before cutover"
expect_rc 2 "deploy test-missing" -- bash "${DEPLOY}/deploy.sh" --version test-missing "${TARGET[@]}" --timeout 10
expect_rc 0 "test1 still serving untouched" -- bash "${DEPLOY}/verify-release.sh" \
  --api-url https://127.0.0.1:18443 --host-header api.rcab.example --insecure --expect-version test1 --timeout 30

echo; echo "REHEARSAL PASSED"
