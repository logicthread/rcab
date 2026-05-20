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

*Every NestJS feature module, what it owns, what it exposes.*

| Module | Owns | Public providers | Notes |
|---|---|---|---|
| `auth` | OTP exchange, JWT issue/refresh, Google link | `AuthService` | [[module-auth]] |
| `users` | User base record | `UsersService` | thin |
| `clients` | Client profile + saved places | `ClientsService` | |
| `drivers` | Driver profile + verification + vehicle ownership | `DriversService` | |
| `rides` | Ride records + state transitions ([[sm-ride-lifecycle]]) | `RidesService`, `RideStateMachine` | [[module-rides]] |
| `dispatch` | Top-K offer flow, offer locks, retries | `DispatchService` | [[module-dispatch]] |
| `matching` | Shared-ride matching, route similarity | `MatchingService` | [[module-matching]] |
| `shared-rides` | Pool entity, slot/open operations | `SharedRidesService` | |
| `rating` | Insert + aggregate ratings | `RatingService` | |
| `geo` | Redis geo wrappers, geohash, distance helpers | `GeoService` | |
| `notifications` | Persist + dispatch (push/WS) | `NotificationsService` | |
| `realtime` | Socket.IO gateway + bus, room conventions | `RealtimeBus` | [[module-realtime]] |

## Dependency direction

See the diagram in [[service-boundaries]]. The TL;DR: **higher-level modules depend on lower-level ones**, not the other way around.

## See also
- [[nestjs-structure]] · [[service-boundaries]]
- [[module-auth]] · [[module-rides]] · [[module-dispatch]] · [[module-matching]] · [[module-realtime]]
