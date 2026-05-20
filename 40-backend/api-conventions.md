---
title: API conventions
tags: [layer/backend, kind/api]
status: accepted
phase: 0
depends_on: [[nestjs-structure]]
related: [[rest-endpoints]], [[websocket-events]], [[error-codes]]
audience: both
---

# API conventions

*Rules every endpoint follows.*

## Versioning

- URI versioning: `/v1/...`. Phase-0 ships v1.
- We bump major versions only when we'd break clients in the wild. Additive changes are not a version bump.

## Auth

- All endpoints except `/v1/auth/*` require a valid rcab JWT in `Authorization: Bearer <token>`.
- JWT carries `sub` (user id), `role`, `auth_method`. Verified by `AuthGuard` (global).
- Role enforcement via `@Roles('driver' | 'client')` decorator backed by `RolesGuard`.

## Request format

- JSON in, JSON out. `Content-Type: application/json`.
- DTO validation via `class-validator`. Reject extra fields (`whitelist: true, forbidNonWhitelisted: true`).
- `Idempotency-Key` header accepted on POSTs that create resources (`/rides/requests`, `/rides/offers/:id/accept`). Server caches the response keyed by `(user_id, idempotency_key)` for 24 h.

## Response format

Standard envelope only for paginated lists:

```json
{ "items": [...], "next_cursor": "opaque" }
```

For single resources, return the resource directly. No `data:` wrapping.

## Error format

Always:

```json
{
  "error": {
    "code": "snake_case_code",
    "message": "Human-readable",
    "details": { ... optional ... },
    "request_id": "01HZ..."
  }
}
```

Codes are stable contract — see [[error-codes]]. HTTP status matches the class of error (4xx vs. 5xx).

## Pagination

Cursor-based using ULID-ish `created_at|id` cursors. `?limit=` is capped at 50.

## Timestamps

All `timestamptz` in ISO 8601 UTC (`...Z`).

## Naming

- URLs: kebab-case, plural nouns. `/v1/ride-requests`, `/v1/rides`.
- JSON fields: `snake_case`. Reason: matches Postgres, sidesteps the camel/snake debate.
- Enum values: lowercase `snake_case`.

## Rate limits

- Phase-0: per-user 60 req/min on writes, 300 req/min on reads. nginx + per-route guards.
- 429 with `Retry-After` header.

## Realtime (Socket.IO)

See [[websocket-events]]. Same JWT used as a handshake token.

## See also
- [[rest-endpoints]] · [[websocket-events]] · [[error-codes]]
- [[nestjs-structure]]
