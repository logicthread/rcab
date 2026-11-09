---
title: Error codes
tags: [layer/backend, kind/api]
status: accepted
phase: 0
depends_on: [[api-conventions]]
related: [[rest-endpoints]]
audience: both
---

# Error codes

*Stable contract. Once shipped, codes never change meaning. New codes are additive.*

## Format

Every error response (from `AppExceptionFilter`):

```json
{ "error": { "code": "...", "message": "...", "request_id": "..." } }
```

There is no `details` object. `request_id` is the `x-request-id` header, also returned on every response.

**How `code` is chosen** (verified against `app-exception.filter.ts`): the `code` of the thrown exception's response object if it has one; otherwise `not_found` (404), `unauthorized` (401), `rate_limited` (429), else `internal_error`. Consequences to know: a `ValidationPipe` 400 has no code of its own and therefore reads **`internal_error` with HTTP 400** (message = the joined validation messages), and the 503 `OsrmUnavailableException` reads `internal_error` with message `routing_unavailable`. Clients must treat the HTTP status as primary and the code as secondary for those cases. (A fix mapping 400 to `validation_error` is proposed in `docs/onboarding/functionality/admin-and-observability.md`.)

## Catalog (codes the code actually emits)

| HTTP | Code | Where / meaning |
|---|---|---|
| 400 | `internal_error` (validation) | DTO validation failed (see above) |
| 400 | `idempotency_key_required` / `idempotency_key_invalid` | `Idempotency-Key` missing on solo/scheduled create / not 1–128 visible ASCII |
| 400 | `invalid_quote` / `quote_expired` / `quote_mismatch` | Quote token missing or tampered / older than 5 min / route differs from the quoted one |
| 400 | `scheduled_for_required` / `scheduled_for_out_of_window` | Scheduled create without a time / outside 15 min – 24 h |
| 400 | `no_vehicle_selected` | Go online without a current vehicle |
| 400 | `reason_required` / `invalid_event` | Driver cancel without a reason / unknown lifecycle event |
| 401 | `unauthorized` | Missing, invalid or expired Bearer token |
| 401 | `invalid_firebase_token` / `invalid_google_token` / `email_not_verified` / `invalid_refresh_token` | Failed credential verification (refresh also covers expired / already used; Google email must be verified) |
| 401 | `account_disabled` | Suspended or deleted user on refresh (403 on exchange / Google login) |
| 401 | `not_found` | Google login with no linked account |
| 403 | `forbidden` | Wrong role or not your resource |
| 403 | `csrf_rejected` | Web refresh/logout from a non-allowlisted Origin/Referer |
| 404 | `ride_not_found`, `vehicle_not_found`, `not_found` | Unknown or invisible resource |
| 409 | `invalid_transition` | Ride state change not allowed from the current state |
| 409 | `no_show_too_early` | No-show before the 5-minute wait |
| 409 | `ride_not_completed` / `already_rated` | Rating a non-completed ride / rating twice |
| 409 | `idempotency_request_in_progress` | Original request with this key still running |
| 409 | `passenger_has_active_pool` / `pool_conflict` | Already holds a shared seat (carries `sharedRideId`) / concurrent pool change, retry |
| 409 | `vehicle_reg_exists`, `google_already_linked` | Duplicate registration number (own vehicles only; a cross-driver duplicate currently returns 500) / Google account linked to another user |
| 422 | `idempotency_key_conflict` | Key reused for a different request |
| 429 | `rate_limited` | Throttler (auth routes 10/min, global 1000/min where applied) |
| 500 | `fare_unavailable` | A legacy shared seat without a recorded fare |
| 500 / 503 | `internal_error` | Catch-all; 503 also for `routing_unavailable` (OSRM down) |
| 501 | `not_implemented` | Unsupported ride `type` |
| — | `offer_expired`, `trip_taken`, `driver_busy`, ... | Not HTTP: accept-ack and `ride_offer_outcome` reasons, see `docs/onboarding/functionality/dispatch-and-offers.md` |

Codes in earlier drafts of this note that never shipped: `validation_failed`, `unauthenticated`, `token_expired`, `state_conflict`, `duplicate_request`, `dispatch_unavailable`, `internal`, `dispatch_no_driver`, `pool_timeout`.

## See also
- [[api-conventions]] · [[rest-endpoints]] · [[websocket-events]]
