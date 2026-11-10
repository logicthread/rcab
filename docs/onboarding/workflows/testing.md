# Workflow: testing

Strategy note: [`90-quality/testing-strategy.md`](../../../90-quality/testing-strategy.md). Rule of the house:
**integration tests use real containers (Testcontainers), not mocks of infrastructure.**

## 1. The layers

| Layer | Tool | Where | Run |
|---|---|---|---|
| API unit | Vitest (+SWC for decorator metadata) | `apps/api/src/**/*.spec.ts` | `pnpm --filter @rcab/api test` |
| API unit + coverage floor | Vitest v8 coverage | same | `pnpm --filter @rcab/api run test:cov` |
| API integration | Vitest + Testcontainers (PostGIS 16 + Redis 7) | `apps/api/test/integration/*.int.spec.ts` | `pnpm test:int` |
| Web unit/component | Vitest + Testing Library (jsdom) | `apps/web/src/**/*.test.ts(x)` | `pnpm --filter @rcab/web test` |
| Web e2e | Playwright (chromium) | `apps/web/e2e/*.e2e.spec.ts` | `pnpm test:e2e` (needs the dev stack up) |
| Driver app | `flutter test` | `apps/driver-app/test/**` | `/flutter-test [unit, widget, integration or all]` |
| Shared packages | Vitest | `packages/*/src/*.test.ts` | `pnpm test` |
| Load | k6 | `infra/load/` | `pnpm test:load` (probe), `pnpm test:load:workload` (business workload), `/k6-load` |
| Host probe | Vitest | `scripts/system-probe.spec.mjs` | `pnpm test:probe` |
| Artifact | node scripts | `apps/api/scripts/check-*` | `pnpm --filter @rcab/api run test:artifact`, `test:dev-loader` |

Single targets:

```bash
pnpm --filter @rcab/api test -- src/modules/rides/rides.controller.spec.ts   # one file
pnpm --filter @rcab/api test -- -t "T27"                                      # one test by name
pnpm --filter @rcab/api test:int -- test/integration/pool-membership.int.spec.ts
```

`apps/driver-app/integration_test/` holds only the scene harness used to record the driver-app onboarding videos
(`demo/`, see [`../videos/driver/INDEX.md`](../videos/driver/INDEX.md)); a regression suite of Flutter
`integration_test`s, as described in the strategy note and `CLAUDE.md`, is planned, not built. Driver coverage today
is `flutter test` unit/widget suites with a fake realtime socket (`test/support/fake_realtime_socket.dart`).

## 2. The gate: `pnpm verify`

```
pnpm verify  =  pnpm lint
             && pnpm policy:doc:check                       # docs/POLICY.md in sync with the policy schema
             && pnpm --filter @rcab/api run test:cov        # unit tests + coverage floor
             && pnpm test:int                               # Testcontainers integration
```

- **Coverage floor** (enforced by `apps/api/vitest.config.ts`, a ratchet set just under the measured baseline):
  statements 75, branches 85, functions 70, lines 75. Raise it as paths get unit tests; never lower it to get green.
- A story is not done, and `/close-story` / `/ship-story` must not run, until `pnpm verify` is green.
- `RCAB_SKIP_INT=1 pnpm test:int` skips the container suites when Docker is unavailable. **Never use it to declare a
  story green** — it exists so a laptop without Docker can still run the rest.
- CI ([`Jenkinsfile`](../../../Jenkinsfile)) runs: install, lint (+`policy:doc:check`, + `tsc --noEmit` per package),
  API artifact check, unit tests (api coverage, web, probe), system-probe smoke, integration tests, then image
  build/identity/push and a gated staging deploy. Nightly ([`Jenkinsfile.nightly`](../../../Jenkinsfile.nightly)):
  stack start, e2e, load, and the monthly backup/restore rehearsal.
- Unhandled promise rejections fail the integration run (`test/setup.unhandled.ts`); there is no "ignore unhandled
  errors" switch. If teardown spews `Connection is closed.`, you have a real double-close bug.

## 3. Test seams and environment switches

Set automatically by the vitest configs / `test/setup.int.ts`:

| Variable | Effect |
|---|---|
| `RCAB_DISABLE_BULL_AUTORUN=1` | BullMQ workers do not start (a booted `AppModule` would otherwise block on `BRPOPLPUSH`) |
| `RCAB_DISABLE_WS_ADAPTER=1` | skip the Socket.IO Redis adapter in unit runs |
| `RCAB_DISABLE_OUTBOX_RELAY=1` | the outbox relay + dispatch reconciler timers do not start; specs construct them and call `drainOnce()` / `reconcile()` deterministically |
| `TEST_POSTGRES_URI`, `TEST_REDIS_URL` | the ephemeral container endpoints; `REDIS_URL`/`DATABASE_URL` are pointed at them too |
| `RCAB_SKIP_INT=1` | skip integration containers |

The schema for integration tests is built from the **same hand-written SQL files** as production via
`@rcab/test-fixtures` (`runMigrations`), so a broken migration fails `pnpm test:int`. `@rcab/test-fixtures` also has
`uniquePhone()` and seed helpers; `apps/api/test/integration/support/dispatch-fixtures.ts` seeds offers, trips and
drivers with raw SQL so specs exercise the code under test rather than the booking path.

## 4. Race-test patterns (the part newcomers get wrong)

Most of the dangerous code in rcab is concurrent: two drivers accepting, a cancel racing an accept, a join racing a
timeout. A single connection cannot expose these — row locks and `ON CONFLICT` behaviour only show up across
sessions. House rules, demonstrated in `pool-membership.int.spec.ts` (T27–T29),
`dispatch-offer-assignment.int.spec.ts`, `scheduled-retry.int.spec.ts`, `rides-idempotency.int.spec.ts`:

1. **Use independent connections.** One `pg.Pool` / service stack per contender (`stack()`), plus an `admin`
   pool for observing. Never run the contenders over one shared client.
2. **Create a barrier with a held lock, not `setTimeout`.** Open a transaction that holds the row lock
   (`holdPoolLock(poolId)`), start all contenders (they park behind the lock), wait until the database reports
   them as waiters (`waitForLockWaiters(admin, n, …, lock.pid)` looks at lock waits), then release the lock. This
   makes the race deterministic and the interleaving maximal.
3. **Assert on committed database state, not return values alone.** After `Promise.all`, snapshot with the admin pool:
   exactly one winner, `seat_count` equals members, one dispatch intent in `outbox`, `ride_stops = 2 * seats`,
   generation bumped once, guard rows consistent.
4. **Assert the typed losers.** Every loser must carry a documented reason (`pool_full`, `pool_closed`,
   `trip_taken`, `driver_busy`, `conflict`); an untyped exception is a bug.
5. **Test the crash windows with fakes at the seam.** The outbox/dispatch specs inject a runner that fails or
   blocks at a chosen point, then assert the intent is re-armable and a duplicate publish is a no-op.
6. **Names map to the test matrix** (T14–T32 in `docs/remediation/stage-c-contract.md`); keep the id in the `it()`
   title so `-t "T27"` finds it.

Invariant SQL (must return zero rows) for driver exclusivity, seat counts and outbox consistency is in the Stage C
contract section 6 and is reused by `scripts/recovery/restore-drill.sh`.

## 5. Web e2e (Playwright)

`apps/web/playwright.config.ts` targets the **already running** dev stack (`E2E_BASE_URL`, default
`http://localhost:3002`) — it does not own a web server. Run `pnpm dev:up` first. One retry in CI; traces on first
retry. Use `/playwright-run [spec] [--headed] [--video]` to record a run for demo sign-off. The sign-in spec is
`apps/web/e2e/signin.e2e.spec.ts`. Scripts used to produce the onboarding videos live in `apps/web/e2e/demo/` (see
[`../videos/web/INDEX.md`](../videos/web/INDEX.md)); they are recordings, not part of the `*.e2e.spec.ts` suite.

## 6. Driver app tests

```bash
cd apps/driver-app && flutter test            # all
flutter test test/features/offer              # one feature
flutter analyze                               # static analysis (also part of /lint)
```

Patterns: notifiers are pure (`OfferNotifier`, `SharedRideNotifier`, `RideNotifier`) so state logic is unit-tested
without timers or sockets; controllers take an injectable `tickInterval` and a `navigate` callback; the socket is the
fake in `test/support/`. A contract fixture shared with the api (`test/fixtures/native_auth_contract.json`,
`apps/api/test/fixtures/native-auth-contract.json`) is pinned by `native-contract-parity.spec.ts` — change both sides
together.

## 7. Load tests (k6)

`infra/load/probe.js` (smoke-level) and `infra/load/workload.js` (realistic booking workload). Budgets are in
policy `perfBudget.*` (see [business-config-changes.md](business-config-changes.md)); `perf-budget.generated.json`
is generated from them. `pnpm load:prepare` seeds tokens for the dev stack (`tokens.generated.json`). Compare results
with `/k6-load` against [`90-quality/performance-budget.md`](../../../90-quality/performance-budget.md).

## 8. What good looks like for a new feature

Write the failing test first (unit), add an integration test for any new SQL/locking, add the multi-connection race
test if two actors can touch the same row, add/adjust the Playwright or Flutter test for the visible behaviour, then
`pnpm verify`. See the worked example in [adding-a-feature-end-to-end.md](adding-a-feature-end-to-end.md).
