---
title: RCAB-E2.S5 — Refresh-token cookie + CSRF posture
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e2-auth]]
demo: 1
estimate: s
hitl: no
depends_on: [[web-auth-firebase]], [[module-auth]], [[story-rcab-e2-s1-otp-exchange]], [[story-rcab-e2-s2-jwt-refresh]]
affected_notes: [[web-auth-firebase]], [[module-auth]]
owner: claude
audience: both
---

# RCAB-E2.S5 — Refresh-token cookie + CSRF posture

## Goal

Harden the token transport: the refresh token is delivered as an HttpOnly cookie (invisible to JS) rather than in a JSON body. This closes the XSS-to-token-theft window. Matching CSRF mitigation is applied to the cookie-bearing endpoints.

## User-facing acceptance criteria

- `Given` a successful firebase-exchange or google-login, `When` the API responds, `Then` the refresh token arrives as a `Set-Cookie` header (HttpOnly, Secure, SameSite=Lax) — the response body contains only `{ rcab_jwt, user }`.
- `Given` a valid refresh cookie, `When` the browser makes a POST to `/v1/auth/refresh` (no body), `Then` a new JWT is issued using the cookie value.
- `Given` a cross-origin form POST to `/v1/auth/refresh` (CSRF attempt), `Then` it is rejected because `SameSite=Lax` blocks cross-site POSTs and the endpoint checks `Origin`/`Referer`.

## Technical acceptance criteria

- `Set-Cookie` attributes: `HttpOnly; Secure; SameSite=Lax; Path=/v1/auth; Max-Age=2592000` (30 days).
- In dev (`NODE_ENV=development`), `Secure` is omitted to allow plain HTTP. Logged as a warning at startup.
- `POST /v1/auth/refresh` reads refresh token from cookie (`refresh_token` cookie name) if body is absent; body still accepted for non-browser clients (driver app, integration tests).
- CSRF protection on cookie-bearing mutation endpoints (`/v1/auth/refresh`, `/v1/auth/logout`): reject if `Origin` header is present and not in `ALLOWED_ORIGINS` env var list.
- `POST /v1/auth/logout` clears the cookie (`Set-Cookie: refresh_token=; Max-Age=0; ...`) in addition to revoking in DB.
- Web client (`useAuth`): calls `/v1/auth/refresh` with no body on mount; expects the cookie to be sent automatically by the browser. No JS code reads or writes the cookie.

## Test plan

- Unit: cookie options set correctly for dev vs. prod env.
- Unit: CSRF check — request with cross-origin `Origin` rejected; same-origin or absent `Origin` passes.
- Integration: exchange → cookie present in response; refresh with cookie (no body) → new JWT; logout → cookie cleared; subsequent refresh → 401.

## Out of scope

- CSRF token header approach (overkill given SameSite=Lax + Origin check).
- Rotating the cookie domain/path for subdomains — single domain in Phase-0.

## See also

- [[epic-e2-auth]] · [[web-auth-firebase]] · [[module-auth]]
- [[story-rcab-e2-s1-otp-exchange]] · [[story-rcab-e2-s2-jwt-refresh]]
