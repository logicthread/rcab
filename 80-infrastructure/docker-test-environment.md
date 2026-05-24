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
    docker-compose.test.yml
    api/Dockerfile.test           # extends Dockerfile.dev, sets NODE_ENV=test
test-fixtures/                    # shared package
  src/
    seed-pilot-city.ts
    fake-drivers.ts
    fake-rides.ts
  package.json
```

## Configuration

- Postgres uses `tmpfs` for `PGDATA` in tests → 5-10× faster.
- Redis with `appendonly no` and `save ""` (no persistence in tests).
- OSRM uses the same fixture PBF as dev — keeps quote outputs deterministic.

## API integration tests (Testcontainers)

```ts
// pseudo
beforeAll(async () => {
  pg = await new PostgreSqlContainer().start();
  redis = await new RedisContainer().start();
  await runMigrations(pg.getConnectionUri());
});
afterAll(async () => { await pg.stop(); await redis.stop(); });
```

A shared `bootstrapTestModule()` in `apps/api/test/setup.ts` wires these container handles into a real Nest module. Modules are not mocked.

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
