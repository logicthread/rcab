---
title: REST endpoints (v1)
tags: [layer/backend, kind/api]
status: accepted
phase: 0
depends_on: [[api-conventions]]
related: [[websocket-events]], [[module-auth]], [[module-rides]], [[module-dispatch]]
audience: both
---

# REST endpoints (v1)

*The complete public HTTP surface for Phase-0. Group by module.*

> Convention: `🔒` = auth required, `🚗` = driver only, `🧍` = client only.

## auth
| Method | Path | Description |
|---|---|---|
| POST | `/v1/auth/firebase-exchange` | Body: `{ firebase_id_token }` → `{ rcab_jwt, refresh_token, user }` |
| POST | `/v1/auth/google/link` 🔒 | Body: `{ google_id_token }` → links to current user |
| POST | `/v1/auth/google/login` | Body: `{ google_id_token }` → JWT if linked |
| POST | `/v1/auth/refresh` | Body: `{ refresh_token }` → new JWT |
| POST | `/v1/auth/logout` 🔒 | revokes refresh token |

## clients (🧍)
| Method | Path | Description |
|---|---|---|
| GET | `/v1/me` 🔒 | current user + role-specific profile |
| PATCH | `/v1/clients/me` 🔒🧍 | update saved places, display name |

## drivers (🚗)
| Method | Path | Description |
|---|---|---|
| GET | `/v1/drivers/me` 🔒🚗 | profile + verification status |
| PATCH | `/v1/drivers/me/vehicle` 🔒🚗 | set current vehicle |
| POST | `/v1/drivers/online` 🔒🚗 | go online (with current location) |
| POST | `/v1/drivers/offline` 🔒🚗 | go offline |
| GET | `/v1/drivers/me/earnings` 🔒🚗 | dashboard data |

## vehicles (🚗)
| Method | Path | Description |
|---|---|---|
| GET | `/v1/vehicles` 🔒🚗 | list owned |
| POST | `/v1/vehicles` 🔒🚗 | add |
| PATCH | `/v1/vehicles/:id` 🔒🚗 | update |

## rides
| Method | Path | Description |
|---|---|---|
| POST | `/v1/rides/quote` 🔒🧍 | Body: `{ origin, dest, type }` → `{ fare_estimate, est_eta, polyline }` |
| POST | `/v1/rides/requests` 🔒🧍 | Body: `{ ...quote_inputs, idempotency }` → request created, dispatch begins |
| POST | `/v1/rides/requests/:id/cancel` 🔒🧍 | cancel |
| GET | `/v1/rides/:id` 🔒 | (client or driver of this ride) |
| POST | `/v1/rides/offers/:id/accept` 🔒🚗 | driver wins the offer |
| POST | `/v1/rides/offers/:id/decline` 🔒🚗 | optional explicit decline |
| POST | `/v1/rides/:id/state` 🔒🚗 | Body: `{ event }` — advance the [[sm-ride-lifecycle]] |
| POST | `/v1/rides/:id/cancel` 🔒 | role-aware cancel |
| GET | `/v1/rides` 🔒 | list mine (paginated) |

## rating
| Method | Path | Description |
|---|---|---|
| POST | `/v1/rides/:id/ratings` 🔒 | Body: `{ stars, text }` — direction inferred from auth |

## notifications
| Method | Path | Description |
|---|---|---|
| GET | `/v1/notifications` 🔒 | list (paginated) |
| POST | `/v1/notifications/:id/read` 🔒 | mark read |

## health
| Method | Path | Description |
|---|---|---|
| GET | `/v1/health/live` | liveness — process up |
| GET | `/v1/health/ready` | readiness — DB+Redis+OSRM reachable |

## See also
- [[api-conventions]] · [[websocket-events]] · [[error-codes]]
- [[module-auth]] · [[module-rides]] · [[module-dispatch]]
