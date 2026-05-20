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

Every error response:

```json
{ "error": { "code": "...", "message": "...", "details": {...}, "request_id": "..." } }
```

## Catalog

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `validation_failed` | Request body failed validation |
| 401 | `unauthenticated` | Missing or invalid token |
| 401 | `token_expired` | Refresh required |
| 403 | `forbidden` | Auth valid but role/scope insufficient |
| 404 | `not_found` | Resource doesn't exist or isn't visible |
| 409 | `state_conflict` | Operation invalid in current state (e.g., can't accept a revoked offer) |
| 409 | `google_already_linked` | Tried to link a Google account already linked elsewhere |
| 409 | `duplicate_request` | Idempotency key reused with different body |
| 422 | `quote_expired` | Quote older than 5 min |
| 429 | `rate_limited` | Rate limit exceeded |
| 503 | `dispatch_unavailable` | Redis / dispatch tier down |
| 503 | `routing_unavailable` | OSRM down |
| 500 | `internal` | Catch-all |
| — | `dispatch_no_driver` | (in `request_status` WS) No driver accepted within budget |
| — | `pool_timeout` | (in `request_status` WS) Shared pool expired with no match |
| — | `offer_expired` | (in `ride_offer_revoked`) Driver's offer expired before accept |

## See also
- [[api-conventions]] · [[rest-endpoints]] · [[websocket-events]]
