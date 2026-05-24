---
title: RCAB-E1.S3 — Docker test environment (docker-compose.test + testcontainers)
tags: [layer/delivery, kind/story]
status: ready
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: m
hitl: no
depends_on: [[story-template]], [[stories-index]]
affected_notes: [[docker-test-environment]], [[testing-strategy]], [[ci-cd]]
owner: claude
audience: both
---

# RCAB-E1.S3 — Docker test environment (docker-compose.test + testcontainers)

## Goal

Integration tests run against **real Postgres + Redis + OSRM containers** — never mocks. The harness boots and tears down the stack per test suite via Testcontainers, with a shared `docker-compose.test.yml` for local dev parity.

## User-facing acceptance criteria

- `Given` a developer machine with Docker, `When` they run `pnpm test:int` at the repo root, `Then` integration tests across `apps/api` run against ephemeral containerized DBs, and the result is the same as in CI.
- `Given` a contributor adds a new integration test, `When` they push, `Then` CI runs the same suite without flakes ≥ 99% over 100 runs.

## Technical acceptance criteria

- `infra/docker/docker-compose.test.yml` parallels the dev compose but with deterministic seeds and `tmpfs` for Postgres data.
- `apps/api` uses `@testcontainers/postgresql` and `@testcontainers/redis` programmatically for fast isolated suites.
- A shared `test-fixtures` package seeds reproducible Postgres state.
- Integration tests skipped if `RCAB_SKIP_INT=1` (for slow laptops).
- Migration runner is invoked in test bootstrap so schema matches prod.

## Test plan

- This story IS the harness; specific tests come from later stories.
- Add 3 representative tests that exercise: a Postgres-only flow, a Redis-only flow, and an OSRM-only flow.

## Out of scope

- E2E web tests (Playwright) — covered later, in the `RCAB-E4.S9` era of work.
- Load tests (k6) — covered by `RCAB-E8.S5`.

## See also
- [[epic-e1-foundation]] · [[docker-test-environment]] · [[testing-strategy]]
