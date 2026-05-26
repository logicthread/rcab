---
title: RCAB-E2.S2 — rcab JWT issue/refresh + revocation
tags: [layer/delivery, kind/story]
status: ready
phase: 0
epic: [[epic-e2-auth]]
demo: 1
estimate: s
hitl: no
depends_on: [[module-auth]], [[rest-endpoints]], [[story-rcab-e2-s1-otp-exchange]]
affected_notes: [[module-auth]], [[rest-endpoints]]
owner: claude
audience: both
---

# RCAB-E2.S2 — rcab JWT issue/refresh + revocation

## Goal

Complete the token lifecycle: a client can trade a valid refresh token for a new JWT (silent re-auth), and can revoke their session on logout. These two endpoints are the scaffolding every authenticated feature depends on.

## User-facing acceptance criteria

- `Given` a valid, non-revoked refresh token, `When` I POST to `/v1/auth/refresh`, `Then` I receive a new rcab JWT with a fresh 15-min expiry.
- `Given` an expired or revoked refresh token, `When` I POST to `/v1/auth/refresh`, `Then` I receive `401 invalid_refresh_token`.
- `Given` a valid JWT, `When` I POST to `/v1/auth/logout`, `Then` the associated refresh token is revoked and future refresh calls with it return `401`.

## Technical acceptance criteria

- `POST /v1/auth/refresh` — body `{ refresh_token }` (or reads HttpOnly cookie set by [[story-rcab-e2-s5-cookie-csrf]]); queries `auth_refresh_token`; rejects if `revoked_at IS NOT NULL` or `expires_at < now()`; issues new JWT.
- `POST /v1/auth/logout` 🔒 — revokes the refresh token associated with the current user (sets `revoked_at = now()`). Returns `204`.
- Refresh tokens are **single-use**: on a successful refresh, the old token is revoked and a new one is issued (rotation). This bounds the damage from a leaked refresh token.
- JWT verification guard (`AuthGuard`) — verifies `iss`, `exp`, `sub` on every 🔒 route; returns `401 unauthorized` on failure.
- `AuthService.refresh(refreshToken)` and `AuthService.revoke(refreshToken)` match the signatures in [[module-auth]].

## Test plan

- Unit: `AuthService.refresh` — mock DB; assert new JWT issued, old token revoked, new token stored.
- Unit: `AuthService.revoke` — assert `revoked_at` set; subsequent refresh with same token rejected.
- Unit: `AuthGuard` — valid JWT passes; expired JWT, wrong issuer, missing `sub` all return 401.
- Integration (Testcontainers Postgres): exchange → refresh → refresh again (uses new token) → logout → refresh fails.

## Out of scope

- Cookie transport for the refresh token — that is RCAB-E2.S5.
- Google-linked refresh (same path, no special handling needed).

## See also

- [[epic-e2-auth]] · [[module-auth]] · [[rest-endpoints]]
- [[story-rcab-e2-s1-otp-exchange]] · [[story-rcab-e2-s5-cookie-csrf]]
