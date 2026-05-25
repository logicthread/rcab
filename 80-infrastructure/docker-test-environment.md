---
title: Docker test environment
tags: [layer/infra, layer/quality]
status: accepted
phase: 0
depends_on: [[docker-dev-environment]], [[testing-strategy]]
related: [[ci-cd]], [[story-rcab-e1-s3-docker-test]]
audience: both
---

# Docker test environment

*Integration tests run against real Postgres, Redis, and OSRM containers — never mocks. CI and local runs use the same harness.*

## Two flavors

| Flavor | When | Lifecycle |
|---|---|---|
| **Testcontainers** | per-suite isolation in `apps/api` integration tests | started by the test runner, destroyed at suite end |
| **docker-compose.test.yml** | local dev parity, the CI smoke job, manual debugging | bring up once, run many tests, bring down |

Both produce the same schema and the same OSRM behavior. The Testcontainers harness exists so individual suites don't contend for the same DB.

## File layout

```
infra/
  docker/
    docker-compose.test.yml       # postgres (tmpfs), redis (no persistence), osrm (--profile osrm)
packages/
  test-fixtures/                  # @rcab/test-fixtures workspace package
    src/
      migrations.ts               # runMigrations() — stub until E1.S7 adds real SQL
      seeds.ts                    # seedPilotCity(), seedDrivers(), … expanded per story
      index.ts
apps/
  api/
    vitest.config.int.ts          # integration test runner config
    test/
      setup.int.ts                # globalSetup: starts PG + Redis containers, runs migrations
      integration/
        pg-roundtrip.int.spec.ts
        redis-roundtrip.int.spec.ts
        osrm-connectivity.int.spec.ts
```

## Configuration

- Postgres uses `tmpfs` for `PGDATA` in tests → 5-10× faster.
- Redis with `appendonly no` and `save ""` (no persistence in tests).
- OSRM uses the same fixture PBF as dev — keeps quote outputs deterministic.

## API integration tests (Testcontainers)

```ts
// apps/api/test/setup.int.ts (vitest globalSetup)
export async function setup() {
  if (process.env.RCAB_SKIP_INT === '1') { process.env.RCAB_INT_SKIPPED = '1'; return; }
  [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgis/postgis:16-3.4').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  process.env.TEST_POSTGRES_URI = pg.getConnectionUri();
  process.env.TEST_REDIS_URL    = redis.getConnectionUrl();
  await runMigrations(pg.getConnectionUri());
}
export async function teardown() { await Promise.allSettled([pg?.stop(), redis?.stop()]); }
```

Test runner is **Vitest** (not Jest — the monorepo standardised on Vitest at E1.S1). Each integration test file uses `describe.skipIf(process.env.RCAB_INT_SKIPPED === '1')(...)`. The API is plain Node HTTP + raw `pg`/`ioredis`; there is no NestJS module to bootstrap at this stage.

## Load tests (k6)

- Separate compose file `infra/docker/docker-compose.load.yml`.
- k6 runs inside a sidecar container and writes results to Prometheus's pushgateway.
- Default scenarios under `infra/load/`: `quote.js`, `dispatch.js`, `driver-online-flood.js` matching [[testing-strategy]] §Load.

## Stability

- Tests skip if `RCAB_SKIP_INT=1`.
- A flake budget: ≤ 1 transient failure per 100 runs of the suite. Anything worse triggers the "quarantine or fix" HITL stop ([[hitl-touchpoints]]).

## See also
- [[docker-dev-environment]] · [[testing-strategy]] · [[ci-cd]]
- [[story-rcab-e1-s3-docker-test]]
