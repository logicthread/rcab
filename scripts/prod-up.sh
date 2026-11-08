#!/usr/bin/env bash
# Bring up the prod + prod-test (CI) compose stack.
#
# NODE_ENV=production makes the api refuse to start without Firebase Admin
# credentials, and firebase-admin parses the private key at boot, so a literal
# placeholder will not do. Generate a throwaway RSA key per run (never committed,
# never valid against Google) unless the caller already exported one.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

if [[ -z "${FIREBASE_SERVICE_ACCOUNT_JSON:-}" ]]; then
  command -v openssl >/dev/null || { echo "[prod-up] openssl is required to generate the throwaway CI key" >&2; exit 1; }
  command -v node >/dev/null || { echo "[prod-up] node is required to generate the throwaway CI key" >&2; exit 1; }
  PRIVATE_KEY="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)"
  FIREBASE_SERVICE_ACCOUNT_JSON="$(PRIVATE_KEY="${PRIVATE_KEY}" node -e '
    process.stdout.write(JSON.stringify({
      type: "service_account",
      project_id: "rcab-ci",
      client_email: "ci@rcab-ci.iam.gserviceaccount.com",
      private_key: process.env.PRIVATE_KEY,
    }));
  ')"
  export FIREBASE_SERVICE_ACCOUNT_JSON
fi

# The prod Compose file requires RCAB_VERSION (it names the image tags). For the
# local/CI prod-test the images are built from source under that tag; the smoke
# step then asserts the running containers report the same version.
export RCAB_VERSION="${RCAB_VERSION:-prodtest}"
export RCAB_BUILT_AT="${RCAB_BUILT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

exec docker compose \
  -f infra/docker/docker-compose.prod.yml \
  -f infra/docker/docker-compose.prod-test.yml \
  up -d --build "$@"
