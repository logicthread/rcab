---
title: Testing strategy
tags: [layer/quality]
status: accepted
phase: 0
depends_on: [[nestjs-structure]], [[driver-flutter-structure]], [[web-nextjs-structure]]
related: [[ci-cd]], [[security-checklist]], [[performance-budget]]
audience: both
---

# Testing strategy

*A pyramid we actually adhere to: many unit, fewer integration, few e2e, focused load.*

## Backend (Node / NestJS)

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest | services, state machines, algorithms (top-K, similarity, rating aggregation). Mocks at the infra boundary |
| Integration | Vitest + Testcontainers | spin up real Postgres + Redis; exercise modules end-to-end with real SQL & Redis commands |
| Contract | Pact (optional Phase-1) | for client ↔ server contracts |
| E2E | Playwright | web flows |
| Load | k6 | dispatch path, quote path, peak driver-online concurrency |

### Auth integration test suite (reference implementation)

`apps/api/test/integration/auth.int.spec.ts` — 36 tests, single Testcontainers Postgres, `singleFork` pool.

Patterns established here should be reused across future integration suites:

- **Shared app per file:** one `beforeAll` builds the NestJS app; all `describe` blocks share it.
- **Provider overrides:** `overrideProvider(FirebaseAdminService)`, `overrideProvider(GoogleVerifierService)`, `overrideProvider(REDIS)` with `vi.fn()` mocks; `overrideProvider(PG_POOL)` with a real test pool.
- **Guard override for throttle:** `overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true })` prevents in-memory rate-limit state from bleeding across tests. The dedicated `rate limiting` describe block spins its own app instance (no override) to test throttle behaviour in isolation.
- **Cookie lifecycle:** use `supertest.agent(app.getHttpServer())` to carry cookies across requests in the same chain.
- **Helpers:** `createTestUser(pool, phone)` seeds via raw SQL; `extractCookieToken(headers)` pulls the `refresh_token` from `Set-Cookie`.
- **Expired JWTs:** `moduleRef.get(JwtService).sign({...}, { expiresIn: -1 })` — no direct `jsonwebtoken` dependency in tests.

### Required coverage

- 100% of state-machine transitions (positive and negative).
- Dispatch path: simulate K drivers, races, expirations, cancellations.
- Shared-ride matching: fixture corpus of (request, pool) pairs with expected slot/open decisions.

## Web (Next.js)

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest + Testing Library | components, hooks |
| Integration | Vitest + MSW | API mocking; React Query behaviors |
| E2E | Playwright | booking → match → ride → rate, against a containerized API in CI |

## Driver app (Flutter)

| Layer | Tool | Scope |
|---|---|---|
| Unit | `flutter test` | providers, business logic |
| Widget | `flutter test` | offer screen, ride screen, online toggle |
| Integration | `integration_test` (`patrol` optional) | login, go-online, accept offer, complete ride against staging API |

## Load testing targets (Phase-0)

- **Quote path:** 200 RPS sustained, p95 ≤ 250 ms.
- **Dispatch path:** 50 concurrent requests, p95 from request → first offer ≤ 1 s.
- **Driver online flood:** 100 drivers going online in 60 s, Redis stable, no dropped sockets.

## Test data

- Factories per entity (`@faker-js/faker`-style).
- A `seed-dev` script populates a city with simulated drivers; used in load tests and demo.

## CI policy

- PR can't merge with red unit/integration jobs.
- E2E and load run nightly on `main`; failures open a Linear ticket but don't block merges.

## See also
- [[ci-cd]] · [[security-checklist]] · [[performance-budget]]
