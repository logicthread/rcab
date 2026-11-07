---
title: Module — auth
tags: [layer/backend, kind/module]
status: accepted
phase: 0
depends_on: [[nestjs-structure]]
related: [[secrets-management]], [[security-checklist]], [[integration-firebase-phone-auth]], [[integration-google-account-link]], [[journey-client-otp-signup]], [[journey-client-google-link]], [[entity-user]]
audience: both
---

# Module — `auth`

*Phone OTP exchange, Google account linking, JWT issue/refresh.*

## Responsibilities

- Exchange a Firebase ID token for an rcab JWT + refresh token.
- Link a Google account to an existing user (post-OTP).
- Log in returning users via Google.
- Refresh JWTs.
- Revoke refresh tokens on logout.

## Public providers

- `AuthService`
  - `exchangeFirebaseToken(idToken): Tokens`
  - `linkGoogle(currentUserId, googleIdToken): void`
  - `loginWithGoogle(googleIdToken): Tokens`
  - `refresh(refreshToken): Tokens`
  - `revoke(refreshToken): void`

## JWT shape

```
{
  iss: "rcab",
  aud: "rcab-api",
  typ: "access",
  sub: "<user_id>",
  role: "client" | "driver",
  auth_method: "phone" | "google",
  iat, exp (15 min)
}
```

Access tokens are HS256. `verifyAccessToken()` (`common/guards/access-token.ts`) checks algorithm, `iss`, `aud` and `typ=access`; `AuthGuard` and the realtime gateway both use it, so quote tokens and untyped tokens are rejected.

## Startup configuration (fail-closed)

- `JWT_SECRET` is resolved at startup (`common/guards/auth-config.ts`). The public dev fallback applies **only** when `NODE_ENV` is `development` or `test`. In every other case, **including `NODE_ENV` unset**, a missing, blank, placeholder, under-32-byte or repetitive secret aborts startup. Errors never echo the secret.
- `CORS_ORIGINS` (`ALLOWED_ORIGINS` accepted as an alias; contradictory values rejected) is the single browser-origin allowlist for credentialed CORS and `CsrfGuard`. Outside dev/test it is required, https-only, bare origins, no wildcard. `CsrfGuard` checks `Origin`, falling back to `Referer`.
- `FIREBASE_SERVICE_ACCOUNT_JSON` is parsed without leaking key material and checked for required fields.
- Secrets handling itself is owned by [[secrets-management]].

## Refresh sessions

- Refresh tokens are 256-bit random base64url values. Only the **SHA-256 digest** is stored: `auth_refresh_token (token_hash, user_id, family_id, auth_method, expires_at, revoked_at)` (migration `0012_refresh_token_hash.sql`; the plaintext column is gone).
- **Single-use atomic rotation:** one conditional `UPDATE ... WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > now() RETURNING` inside the transaction that inserts the replacement. Zero rows means 401. Of two concurrent refreshes exactly one succeeds.
- **Reuse detection:** replaying a consumed or revoked token revokes its whole session family (`family_id`). **Grace window 10 s** (`REFRESH_REUSE_GRACE_SECONDS`): reuse of a token revoked <10 s ago (concurrent refresh, lost response) gets 401 without revoking the family and never mints a sibling token; older reuse revokes the family.
- Refresh keeps the session's original `auth_method` (phone/google).
- **Account status:** suspended/deleted users get 403 `account_disabled` at phone exchange and Google login, and 401 `account_disabled` at refresh (all of the user's refresh tokens are revoked).

## Web vs native contract

- Web: HttpOnly refresh cookie plus CSRF (Origin/Referer) on `/v1/auth/refresh`; `/v1/auth/logout` revokes the session server-side (the web client calls it on sign-out).
- Native (driver app): explicit JSON endpoints, no cookies, no CSRF; refresh token held in secure storage. Native is a separate route family, never inferred from User-Agent or a client flag.
  - `POST /v1/auth/native/firebase-exchange` `{id_token}` returns 200 tokens
  - `POST /v1/auth/native/refresh` `{refresh_token}` returns 200 rotated tokens
  - `POST /v1/auth/native/logout` `{refresh_token}` returns 204 — possession-based (no Bearer needed, works after access token expiry), idempotent, throttled 10/min
  - Example shapes: `apps/api/test/fixtures/native-auth-contract.json` (asserted by the controller spec and integration suite).

## Internal collaborators

- `infra/firebase` — Firebase Admin SDK
- `users` module — to find-or-create user rows

## Tests

- Unit: token verification mocking the Firebase SDK
- Integration: round-trip OTP exchange + refresh
- Negative: tampered token, expired token, replayed refresh (family revoked), concurrent refresh race, suspended account, weak/missing `JWT_SECRET`, wrong `aud`/`typ`
- Story: [[story-rcab-e8-s7-review-remediation-stage-ab]]

## See also
- [[integration-firebase-phone-auth]] · [[integration-google-account-link]]
- [[journey-client-otp-signup]] · [[journey-client-google-link]]
- [[entity-user]]
