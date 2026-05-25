---
title: RCAB-E1.S8 — Health endpoints (/v1/health/live + /v1/health/ready)
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: xs
hitl: no
depends_on: [[story-template]], [[stories-index]]
affected_notes: [[rest-endpoints]], [[observability]]
owner: claude
audience: both
---

# RCAB-E1.S8 — Health endpoints (/v1/health/live + /v1/health/ready)

## Goal

Two unambiguous health endpoints that nginx, Uptime Kuma, the CI smoke job, and the operator can all use to know the system is alive.

## User-facing acceptance criteria

- `Given` the API is running, `When` I `GET /v1/health/live`, `Then` I always get 200 (process is up).
- `Given` Postgres, Redis, and OSRM are reachable, `When` I `GET /v1/health/ready`, `Then` I get 200 with a JSON body listing each dep's status.
- `Given` Redis is killed, `When` I `GET /v1/health/ready`, `Then` I get 503 with the failing dep called out.

## Technical acceptance criteria

- `live` is a no-dep handler that returns immediately.
- `ready` checks: Postgres `SELECT 1`, Redis `PING`, OSRM small `/route` ping. Each with a 1s timeout.
- Both endpoints are unauthenticated and unlogged at `info` level (we don't want to pollute logs).
- The readiness path is what `docker compose` healthchecks use too.

## Test plan

- Unit: each handler with mocked deps for live and ready (positive + each-dep-down).
- Integration: bring up the test stack, kill Redis, verify 503.

## Out of scope

- Per-dep liveness endpoints — one ready endpoint is enough.

## See also
- [[epic-e1-foundation]] · [[rest-endpoints]] · [[observability]]
