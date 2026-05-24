---
title: RCAB-E1.S2 — Docker dev environment (docker-compose.dev + devcontainer)
tags: [layer/delivery, kind/story]
status: ready
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: m
hitl: no
depends_on: [[story-template]], [[stories-index]]
affected_notes: [[docker-dev-environment]], [[docker-compose]], [[ADR-0009-single-vps-phase-0]]
owner: claude
audience: both
---

# RCAB-E1.S2 — Docker dev environment (docker-compose.dev + devcontainer)

## Goal

A single command boots the whole development environment in Docker: Postgres, Redis, OSRM, plus hot-reloading `api` and `web` services. No host install of node/postgres/redis is required to start contributing. (Flutter still runs on the host or in an emulator — Android tooling in Docker is more pain than gain.)

## User-facing acceptance criteria

- `Given` a fresh checkout on macOS / Linux with Docker installed, `When` I run `pnpm dev:up`, `Then` `api`, `web`, `postgres`, `redis`, and `osrm` containers are running and `api` connects to `postgres` and `redis` successfully.
- `Given` the dev environment is up, `When` I edit a `.ts` file in `apps/api`, `Then` the API hot-reloads within 3 seconds.
- `Given` the dev environment is up, `When` I edit `apps/web`, `Then` Next.js HMR updates the browser within 2 seconds.
- `Given` VS Code + Dev Containers extension, `When` I "Reopen in container", `Then` I land in a fully-configured shell with pnpm, node 20, and git available, mounted at `/workspace`.

## Technical acceptance criteria

- `infra/docker/docker-compose.dev.yml` defines all dev services on a shared `rcab_dev_net`.
- `apps/api/Dockerfile.dev` uses `node:20-bookworm-slim`, mounts source as a volume, runs `pnpm dev` with `tsx watch`.
- `apps/web/Dockerfile.dev` mirrors the above for Next.js dev mode.
- `infra/docker/osrm/` contains a `Dockerfile` that pulls a small fixture PBF (a single Indian city for dev — committed via Git LFS or downloaded at first up).
- `.devcontainer/devcontainer.json` references the dev compose file.
- A `.env.dev.example` documents every env var the dev stack reads; `.env.dev` is gitignored.
- `pnpm dev:up`, `pnpm dev:down`, `pnpm dev:logs` shortcuts in root `package.json`.

## Test plan

- Smoke: a CI job that runs `pnpm dev:up`, waits for `/v1/health/ready`, then `pnpm dev:down`.
- Unit: covered by other stories.

## Out of scope

- Flutter in Docker.
- Production compose (that's [[story-rcab-e1-s4-docker-prod]]).
- Real OSRM extract — dev uses a fixture city only.

## See also
- [[epic-e1-foundation]] · [[docker-dev-environment]] · [[docker-compose]]
