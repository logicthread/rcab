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
| `osrm-prep` (one-shot) | `alpine:3.19` | downloads PBF into `osrm-data` volume on first up | — |
| `osrm-extract` (one-shot) | `osrm/osrm-backend:latest` | extracts + partitions + customizes the OSRM graph; skipped if already present | — |
| `osrm` | `osrm/osrm-backend:latest` | serves `osrm-routed --algorithm mld` on `:5000` | n/a |
| `mailhog` (optional) | `mailhog/mailhog` | — | for future email work |
| `loki + promtail + prometheus + alertmanager + grafana + uptime-kuma` | per [[observability]] | — | n/a |

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
    # No osrm/ Dockerfile in Phase-0 — the dev compose uses
    # alpine + osrm/osrm-backend directly. See ADR-0009 for rationale.
      pbf/
        fixture-city.osm.pbf      # ~ 50 MB; committed via Git LFS
  .devcontainer/
    devcontainer.json
.env.dev.example                  # documents every env var
.env.dev                          # gitignored
```

## Bring-up

```bash
# `.env.dev` is auto-created from `.env.dev.example` on first `dev:up`.
pnpm dev:up                       # docker compose up -d --build
pnpm dev:smoke                    # polls api / until 200 (or DEV_SMOKE_TIMEOUT)
pnpm dev:logs                     # tail
pnpm dev:down                     # docker compose down
```

`pnpm dev:up` brings containers up in the background. `pnpm dev:smoke` (added in [[story-rcab-e1-s2-docker-dev]]) polls the api root until it reports postgres + redis ready. Once [[story-rcab-e1-s8-health-endpoints]] lands, smoke will poll `/v1/health/ready` instead and the two commands may be merged into a single blocking `dev:up`.

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
