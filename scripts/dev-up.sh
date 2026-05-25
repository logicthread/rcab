#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

if [[ ! -f .env.dev ]]; then
  echo "[dev:up] .env.dev not found — copying from .env.dev.example"
  cp .env.dev.example .env.dev
fi

docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml --profile obs up -d --build "$@"

echo ""
echo "[dev:up] API:          http://localhost:3000"
echo "[dev:up] Web:          http://localhost:3002"
echo "[dev:up] Grafana:      http://localhost:3001  (admin / admin)"
echo "[dev:up] Prometheus:   http://localhost:9090"
echo "[dev:up] Uptime Kuma:  http://localhost:3003"
echo ""
echo "[dev:up] Slim mode (no observability): pnpm dev:up:slim"
