---
title: Module map
tags: [layer/backend, kind/moc]
status: accepted
phase: 0
depends_on: [[nestjs-structure]], [[service-boundaries]]
related: [[module-auth]], [[module-rides]], [[module-dispatch]], [[module-matching]], [[module-realtime]]
audience: both
---

# Module map

*Every NestJS feature module under `apps/api/src/modules/`, what it owns, what it exposes.*
*The 14 rows below are the actual module directories under `modules/`. Keep in sync with `pnpm code:graph:check`.*

| Module | Owns | Public providers (exports) | Notes |
|---|---|---|---|
| `auth` | OTP exchange, JWT issue/refresh/revoke, Google link, CSRF | `AuthGuard`, `CsrfGuard`, `JwtModule` | [[module-auth]] · `AuthService` internal |
| `drivers` | Driver profile, verification, availability toggle | `DriversService` | `DriversController` |
| `vehicles` | Vehicle registration + ownership | — | `VehiclesService`, `VehiclesController` |
| `rides` | Solo ride records, `/v1/rides*` controller (quote, create, state, cancel), quote tokens, idempotent create, the solo forward + cancel state machine | `RidesRepository`, `RideStateMachine` | [[module-rides]] · `QuoteTokenService`, `IdempotencyRepository`, `RidesRealtimeListener` internal |
| `ride-lifecycle` | Shared-trip stop confirmation (`stop:pickup_confirmed` / `stop:drop_confirmed`), pool `closed_started` → `completed`, guard release | `RideLifecycleService` | Solo transitions (accepted → en_route → arrived → in_progress → completed, [[sm-ride-lifecycle]]) live in `rides` (`RideStateMachine`), not here |
| `dispatch` | Top-K offer flow, `dispatch_offer` rows, the accept transaction + `driver_active_assignment` guard, wave/hard-fail timers | `DispatchService`, `DispatchStartService` | [[module-dispatch]] · `DispatchProcessor` (BullMQ worker) and the `DispatchReconciler` are hosted by `DispatchRunnerModule` |
| `matching` | Shared-ride matching, route similarity, pool lifecycle | `MatchingService`, `RouteSimilarityService`, `SharedRideRepository`, `RideStopRepository`, `PoolLifecycleService` | [[module-matching]] · pool/shared-ride logic lives here · `PoolExpireProcessor` (BullMQ) |
| `pricing` | Fare + per-seat pricing | `PricingService` | |
| `rating` | Two-sided rating insert + invariants | — | **Insert built RCAB-E4.S9** (`POST /v1/rides/:id/ratings`, `RatingService`, `RatingRepository`); aggregation + denorm is E7 |
| `realtime` | Socket.IO gateway + bus, room conventions | `RealtimeBus` | [[module-realtime]] · `RealtimeGateway` internal |
| `health` | Liveness / readiness probes, build identity, `/metrics` | — | `HealthController` (`/v1/health/live`, `/ready`, `/version`, `/metrics`, `/`) |
| `scheduled` | Scheduled-booking wake queue (BullMQ delayed jobs, E6) and the retry-until-cutoff policy | `ScheduledDispatchService` | wakes a future ride ~10 min before pickup → normal dispatch (S3); queue `bull:scheduled-dispatch:*`; `scheduled-retry.ts` re-arms an unanswered window |
| `outbox` | Transactional outbox: `enqueueOutbox`, `OutboxRelay` (lease → BullMQ), `DispatchReconciler` (rebuild lost work from Postgres), deterministic job ids | `OutboxRelay`, `OutboxRepository`, `enqueueOutbox` | Stage C (RCAB-E8.S8); see `docs/onboarding/functionality/idempotency-and-durability.md` |
| `metrics` | `BusinessMetricsSampler`: state-shaped gauges (active/busy drivers, outbox backlog, shared match rate) | — | RCAB-E8.S12; counters/histograms live in `apps/api/src/metrics.ts` |

Cross-cutting infra (not feature modules) lives under `apps/api/src/infra/`: `DrizzleModule` (Postgres), `RedisModule`, `FirebaseModule`, `GoogleModule`. Business configuration is the global `PolicyModule` (`apps/api/src/config/policy/`, see [[policy-config]]), and `DispatchRunnerModule` (`modules/dispatch/dispatch-runner.module.ts`) hosts the queue workers and the reconciler.

**Concepts without a dedicated module** (folded in, deliberately): *users/clients* → identity is carried by `auth` (user record) + `passenger_id` on rides/ratings, no separate profile module in Phase-0; *shared-rides* → owned by `matching` (`SharedRideRepository`, `PoolLifecycleService`); *geo* → Redis geo wrappers live in `drivers`/`realtime` + `infra/redis`; *notifications* → `realtime` bus + driver-app FCM, no persistence module yet.

## Dependency direction

See the diagram in [[service-boundaries]]. The TL;DR: **higher-level modules depend on lower-level ones**, not the other way around.

## See also
- [[nestjs-structure]] · [[service-boundaries]]
- [[module-auth]] · [[module-rides]] · [[module-dispatch]] · [[module-matching]] · [[module-realtime]]
