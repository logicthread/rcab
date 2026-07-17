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
*The 11 rows below are the actual module files. Keep in sync with `pnpm code:graph:check`.*

| Module | Owns | Public providers (exports) | Notes |
|---|---|---|---|
| `auth` | OTP exchange, JWT issue/refresh/revoke, Google link, CSRF | `AuthGuard`, `CsrfGuard`, `JwtModule` | [[module-auth]] · `AuthService` internal |
| `drivers` | Driver profile, verification, availability toggle | `DriversService` | `DriversController` |
| `vehicles` | Vehicle registration + ownership | — | `VehiclesService`, `VehiclesController` |
| `rides` | Solo ride records, quote tokens, state machine | `RidesRepository` | [[module-rides]] · `RideStateMachine`, `QuoteTokenService`, `RidesRealtimeListener` internal |
| `ride-lifecycle` | Solo ride state transitions ([[sm-ride-lifecycle]]) | `RideLifecycleService` | accepted → en_route → arrived → in_progress → completed |
| `dispatch` | Top-K offer flow, offer locks, wave retries | `DispatchService` | [[module-dispatch]] · `DispatchProcessor` (BullMQ) |
| `matching` | Shared-ride matching, route similarity, pool lifecycle | `MatchingService`, `RouteSimilarityService`, `SharedRideRepository`, `RideStopRepository`, `PoolLifecycleService` | [[module-matching]] · pool/shared-ride logic lives here · `PoolExpireProcessor` (BullMQ) |
| `pricing` | Fare + per-seat pricing | `PricingService` | |
| `rating` | Two-sided rating insert + invariants | — | **Insert built RCAB-E4.S9** (`POST /v1/rides/:id/ratings`, `RatingService`, `RatingRepository`); aggregation + denorm is E7 |
| `realtime` | Socket.IO gateway + bus, room conventions | `RealtimeBus` | [[module-realtime]] · `RealtimeGateway` internal |
| `health` | Liveness / readiness probes | — | `HealthController` (`/v1/health/live`, `/ready`) |
| `scheduled` | Scheduled-booking wake queue (BullMQ delayed jobs, E6) | `ScheduledDispatchService` | wakes a future ride ~10 min before pickup → normal dispatch (S3); queue `bull:scheduled-dispatch:*` |

Cross-cutting infra (not feature modules) lives under `apps/api/src/infra/`: `DrizzleModule` (Postgres), `RedisModule`, `FirebaseModule`, `GoogleModule`.

**Concepts without a dedicated module** (folded in, deliberately): *users/clients* → identity is carried by `auth` (user record) + `passenger_id` on rides/ratings, no separate profile module in Phase-0; *shared-rides* → owned by `matching` (`SharedRideRepository`, `PoolLifecycleService`); *geo* → Redis geo wrappers live in `drivers`/`realtime` + `infra/redis`; *notifications* → `realtime` bus + driver-app FCM, no persistence module yet.

## Dependency direction

See the diagram in [[service-boundaries]]. The TL;DR: **higher-level modules depend on lower-level ones**, not the other way around.

## See also
- [[nestjs-structure]] · [[service-boundaries]]
- [[module-auth]] · [[module-rides]] · [[module-dispatch]] · [[module-matching]] · [[module-realtime]]
