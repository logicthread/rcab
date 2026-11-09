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

*The public HTTP surface for Phase-0, grouped by module. Rows marked **not built** are design intent that no controller implements yet; the 26 shipped routes are listed with their handlers in `codegraph/graph.md` (regenerate with `pnpm code:graph`) and narrated in `docs/onboarding/functionality/`.*

> Convention: `🔒` = auth required, `🚗` = driver only, `🧍` = client only.

## auth
| Method | Path | Description |
|---|---|---|
| POST | `/v1/auth/firebase-exchange` | Web. Body: `{ id_token }` (Firebase ID token) → `{ access_token, token_type, expires_in, user }`; the refresh token is set as the HttpOnly cookie `refresh_token` (`SameSite=Lax`, path `/v1/auth`) and is **not** in the JSON. Throttled 10/min |
| POST | `/v1/auth/google/link` 🔒 | Body: `{ google_id_token }` → links to current user |
| POST | `/v1/auth/google/login` | Body: `{ google_id_token }` → JWT if linked |
| POST | `/v1/auth/refresh` | Web. Reads the `refresh_token` cookie (a body `refresh_token` is also accepted), Origin/Referer must be in `CORS_ORIGINS` → rotated `{ access_token, ... }` + new cookie. Single use; replay after the 10 s grace revokes the family |
| POST | `/v1/auth/logout` 🔒 | Web. Needs a valid Bearer and an allowed Origin; revokes the presented refresh token and clears the cookie → 204 |
| POST | `/v1/auth/native/firebase-exchange` | Native clients. Body `{ id_token }` → 200 tokens JSON (no cookie, no CSRF) |
| POST | `/v1/auth/native/refresh` | Native. Body `{ refresh_token }` → 200 rotated tokens; replay revokes the session family |
| POST | `/v1/auth/native/logout` | Native. Body `{ refresh_token }` → 204 always. Possession of the refresh token is the credential (no Bearer needed, so it works after the access token expired); throttled 10/min |

Auth errors: 403 `account_disabled` (exchange/Google login), 401 `account_disabled` (refresh). See [[module-auth]].

## clients (🧍)
| Method | Path | Description |
|---|---|---|
| GET | `/v1/me` 🔒 | current user + role-specific profile — **not built** |
| PATCH | `/v1/clients/me` 🔒🧍 | update saved places, display name — **not built** |

## drivers (🚗)
| Method | Path | Description |
|---|---|---|
| GET | `/v1/drivers/me` 🔒🚗 | profile + verification status — **not built** |
| PATCH | `/v1/drivers/me/vehicle` 🔒🚗 | set current vehicle |
| POST | `/v1/drivers/online` 🔒🚗 | go online. Body `{ lat, lng }`; 400 `no_vehicle_selected` without a current vehicle |
| POST | `/v1/drivers/offline` 🔒🚗 | go offline |
| GET | `/v1/drivers/me/earnings` 🔒🚗 | dashboard data — **not built** (E7.S4) |

## vehicles (🚗)
| Method | Path | Description |
|---|---|---|
| GET | `/v1/vehicles` 🔒🚗 | list owned |
| POST | `/v1/vehicles` 🔒🚗 | add |
| PATCH | `/v1/vehicles/:id` 🔒🚗 | update |

## rides
| Method | Path | Description |
|---|---|---|
| POST | `/v1/rides/quote` 🔒🧍 | Body: `{ type: normal\|shared\|scheduled, originLat, originLng, destLat, destLng }` → `{ type, distanceM, durationS, soloFare: Money, geometry, quoteToken, sharedEstimate?: { perSeatPrice: Money, seatMultiplier, detourFactor, seatCount } }`. Side-effect-free. (RCAB-E5.S5) |
| POST | `/v1/rides` 🔒🧍 | Body: `{ type, originLat, originLng, destLat, destLng, quoteToken?, scheduledFor? }` (no `passengerId`; identity is the JWT). `type=shared` → `{ sharedRideId, passengerId, mode, poolStatus, perSeatPrice: Money, farePolicy, seatMultiplier?, detourFactor? }` (matching, optional `Idempotency-Key`). `type=normal` / `scheduled` → `{ rideId, passengerId, status: 'requested', fare }`; `Idempotency-Key` header **required**, `quoteToken` required, `scheduledFor` (15 min–24 h ahead) required for scheduled. (RCAB-E4.S2, E5.S2–S5, E6.S2) |
| POST | `/v1/rides/requests/:id/cancel` 🔒🧍 | cancel (legacy abstract `ride_request` model — **not built**; solo cancel ships as `/v1/rides/:id/cancel`, RCAB-E4.S8) |
| GET | `/v1/rides/:id` 🔒 | (client or driver of this ride) → status + lifecycle timestamp trail (RCAB-E4.S6). Used for mount + reconnect-restore. |
| POST | `/v1/rides/offers/:id/accept` 🔒🚗 | **not built as HTTP**: accept/decline are the Socket.IO event `ride_offer_response { offerId, accept }` (see [[websocket-events]]) |
| POST | `/v1/rides/offers/:id/decline` 🔒🚗 | **not built as HTTP** (see above) |
| POST | `/v1/rides/:id/state` 🔒🚗 | Body: `{ event }` — advance the [[sm-ride-lifecycle]] (RCAB-E4.S6). `event` ∈ `start_en_route`/`mark_arrived`/`start_ride`/`end_ride`; only the bound driver. 200 `{ rideId, status }`; 409 out-of-order; 403 not-owner; 404 unknown. Cancellation is `/cancel` (E4.S8). |
| POST | `/v1/rides/:id/cancel` 🔒 | Role-aware cancel of a solo ride (RCAB-E4.S8). Body: `{ reason? }` (required for a driver cancel) or `{ event: 'mark_no_show' }` (driver no-show). Client cancels pre-`in_progress`; driver cancels pre-`completed`; no-show only from `arrived` after the 5-min wait. 200 `{ rideId, status, cancelledBy }`; 403 not-your-ride / non-driver no-show; 404 unknown; 409 `invalid_transition` or `no_show_too_early`. **No fee in Phase-0** (deferred). |
| GET | `/v1/rides/:id/stops` 🔒🚗 | the claimed driver reads a shared trip's ordered stops (403 for anyone else) |
| GET | `/v1/rides` 🔒 | list mine (paginated) — **not built** (E7.S3) |

`Money = { amount: integer minor units, currency: 'INR' }`. See [[features-shared-rides]] § Pricing for the per-seat formula.

## rating
| Method | Path | Description |
|---|---|---|
| POST | `/v1/rides/:id/ratings` 🔒 | Body: `{ stars (1–5), text? }` — rate the other party of a **completed** ride; direction inferred from auth (client→driver / driver→client). **Shipped RCAB-E4.S9.** 201 `{ id, rideId, subjectId, stars }`; 400 stars out of range; 403 not a party; 404 unknown; 409 `ride_not_completed` / `already_rated`. Capture only — aggregation + the rating display are E7. |

## notifications
| Method | Path | Description |
|---|---|---|
| GET | `/v1/notifications` 🔒 | list (paginated) — **not built** |
| POST | `/v1/notifications/:id/read` 🔒 | mark read — **not built** |

## health
| Method | Path | Description |
|---|---|---|
| GET | `/v1/health/live` | liveness — process up |
| GET | `/v1/health/ready` | readiness — DB+Redis+OSRM reachable (also served at `GET /`) |
| GET | `/v1/health/version` | build identity `{ version, builtAt }` (RCAB-E8.S11) |
| GET | `/metrics` | Prometheus exposition (not under `/v1`) |

## See also
- [[api-conventions]] · [[websocket-events]] · [[error-codes]]
- [[module-auth]] · [[module-rides]] · [[module-dispatch]]
