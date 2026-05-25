#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

if [[ ! -f .env.dev ]]; then
  echo "[dev:up] .env.dev not found — copying from .env.dev.example"
  cp .env.dev.example .env.dev
fi

exec docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml up -d --build "$@"
