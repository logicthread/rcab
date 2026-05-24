---
title: Docker dev environment
tags: [layer/infra]
status: accepted
phase: 0
depends_on: [[docker-compose]]
related: [[docker-test-environment]], [[story-rcab-e1-s2-docker-dev]], [[ADR-0009-single-vps-phase-0]]
audience: both
---

# Docker dev environment

*One command on a fresh checkout brings up the whole development stack. No host installs of Node/Postgres/Redis are required.*

## Why all-in-Docker for dev

- New contributors join in minutes, not days.
- "Works on my machine" disappears: the dev stack is the same shape as prod.
- The Phase-0 production target is itself a single VPS running compose; treating dev the same way means our compose-fu stays sharp from day one.

## What runs

| Service | Image | Source mount | Hot reload |
|---|---|---|---|
| `api` | local Dockerfile.dev (node:20) | `./apps/api → /workspace/apps/api` | `tsx watch` |
| `web` | local Dockerfile.dev (node:20) | `./apps/web → /workspace/apps/web` | Next.js HMR |
| `postgres` | `postgis/postgis:16-3.4` | — | n/a |
| `redis` | `redis:7-alpine` | — | n/a |
| `osrm` | local Dockerfile with a fixture city PBF | — | n/a |
| `mailhog` (optional) | `mailhog/mailhog` | — | for future email work |
| `loki + promtail + prometheus + grafana + uptime-kuma` | per [[observability]] | — | n/a |

Flutter is **not** in Docker — Android tooling fights with containers. The driver app runs on the host or in an emulator and talks to the API at `http://10.0.2.2:3000` (Android emulator) or `http://localhost:3000` (host).

## File layout

```
infra/
  docker/
    docker-compose.dev.yml
    api/
      Dockerfile.dev
    web/
      Dockerfile.dev
    osrm/
      Dockerfile
      pbf/
        fixture-city.osm.pbf      # ~ 50 MB; committed via Git LFS
  .devcontainer/
    devcontainer.json
.env.dev.example                  # documents every env var
.env.dev                          # gitignored
```

## Bring-up

```bash
cp .env.dev.example .env.dev      # first time only
pnpm dev:up                       # docker compose up -d
pnpm dev:logs                     # tail
pnpm dev:down                     # docker compose down
```

`pnpm dev:up` blocks until `/v1/health/ready` returns 200; the operator sees a friendly progress UI rather than racing into `curl` themselves.

## Hot reload contracts

- API: `tsx watch` re-runs on `**/*.ts` change inside `apps/api/src`. Restart visible in ≤ 3 s.
- Web: Next.js dev server with HMR; page hot-updates in ≤ 2 s.
- Migrations: applied automatically on first `dev:up`; subsequent migrations run via `pnpm migrate:up` from the host (the same migrator container).

## VS Code Dev Containers

`.devcontainer/devcontainer.json` references the dev compose file's `api` service so contributors using "Reopen in Container" land in a fully-configured shell mounted at `/workspace`, with node 20, pnpm, and git pre-installed.

## Network

All services on a single `rcab_dev_net`. Only `api`, `web`, and `grafana` publish ports to the host:

- `:3000` — api
- `:3001` — grafana
- `:5173` (or `:3002`) — web

Postgres and Redis never publish; use `docker compose exec postgres psql` or `docker compose exec redis redis-cli` when you need them.

## Resource hints

This stack runs on a dev machine with ≥ 8 GB RAM comfortably. On 16 GB+ machines you can keep the observability stack hot; on 8 GB consider `pnpm dev:up --no-obs` (a profile that skips loki+grafana).

## See also
- [[docker-test-environment]] · [[docker-compose]] · [[observability]]
- [[story-rcab-e1-s2-docker-dev]]
