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

*Google sign-in/registration (active), phone OTP exchange (disabled until launch), JWT issue/refresh.*

> **2026-11-10 (RCAB-E8.S15):** only `google` is in `auth.enabledMethods` until launch ([[ADR-0003-otp-firebase]] amendment). Firebase exchange endpoints return 403 `auth_method_disabled`. The OTP provider for launch is TBD and may not be Firebase, so the phone path sits behind the flag as a clean provider slot.

## Responsibilities

- Verify a Google ID token directly with Google and log in / register by `google_sub` (`loginOrRegisterWithGoogle`, web + native).
- Publish the enabled methods and Google client id (`GET /v1/auth/config`).
- Exchange a Firebase ID token for an rcab JWT + refresh token (**disabled** unless `phone` is enabled).
- Link a Google account to an existing user (post-OTP).
- Log in returning users via Google.
- Refresh JWTs.
- Revoke refresh tokens on logout.

## Public providers

- `AuthService`
  - `loginOrRegisterWithGoogle(googleIdToken): Tokens` (active; registers role `client`, no email auto-link)
  - `exchangeFirebaseToken(idToken): Tokens` (gated by `auth.enabledMethods`)
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
- `GOOGLE_CLIENT_IDS` (comma list of accepted Google audiences; `GOOGLE_CLIENT_ID` alias) is infra config, not policy. Unset in dev: Google sign-in returns 503 `google_not_configured`, boot is unaffected.
- `FIREBASE_SERVICE_ACCOUNT_JSON` is parsed without leaking key material and checked for required fields.
- Secrets handling itself is owned by [[secrets-management]].

## Refresh sessions

- Refresh tokens are 256-bit random base64url values. Only the **SHA-256 digest** is stored: `auth_refresh_token (token_hash, user_id, family_id, auth_method, expires_at, revoked_at)` (migration `0012_refresh_token_hash.sql`; the plaintext column is gone).
- **Single-use atomic rotation:** one conditional `UPDATE ... WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > now() RETURNING` inside the transaction that inserts the replacement. Zero rows means 401. Of two concurrent refreshes exactly one succeeds.
- **Reuse detection:** replaying a consumed or revoked token revokes its whole session family (`family_id`). **Grace window 10 s** (`REFRESH_REUSE_GRACE_SECONDS`): reuse of a token revoked <10 s ago (concurrent refresh, lost response) gets 401 without revoking the family and never mints a sibling token; older reuse revokes the family.
- Refresh keeps the session's original `auth_method` (phone/google).
- **Account status:** suspended/deleted users get 403 `account_disabled` at phone exchange and Google login, and 401 `account_disabled` at refresh (all of the user's refresh tokens are revoked).

## Web vs native contract

- Web: `POST /v1/auth/google` (active) and `/v1/auth/firebase-exchange` (gated) set the refresh cookie; HttpOnly refresh cookie plus CSRF (Origin/Referer) on `/v1/auth/refresh`; `/v1/auth/logout` revokes the session server-side (the web client calls it on sign-out).
- Native (driver app): explicit JSON endpoints, no cookies, no CSRF; refresh token held in secure storage. Native is a separate route family, never inferred from User-Agent or a client flag.
  - `POST /v1/auth/native/google` `{id_token}` returns 200 tokens (active)
  - `POST /v1/auth/native/firebase-exchange` `{id_token}` returns 200 tokens (403 `auth_method_disabled` while `phone` is not enabled)
  - `POST /v1/auth/native/refresh` `{refresh_token}` returns 200 rotated tokens
  - `POST /v1/auth/native/logout` `{refresh_token}` returns 204 — possession-based (no Bearer needed, works after access token expiry), idempotent, throttled 10/min
  - Example shapes: `apps/api/test/fixtures/native-auth-contract.json` (asserted by the controller spec and integration suite).

## Internal collaborators

- `infra/google` — Google ID token verification (`google-auth-library`)
- `infra/firebase` — Firebase Admin SDK (phone path and FCM only)
- Policy `auth.enabledMethods` (`AUTH_ENABLED_METHODS`) — see [[POLICY]]
- `users` module — to find-or-create user rows

## Tests

- Unit: Google/Firebase token verification with the SDK mocked at the verifier boundary
- Integration: round-trip OTP exchange + refresh
- Negative: tampered token, expired token, replayed refresh (family revoked), concurrent refresh race, suspended account, weak/missing `JWT_SECRET`, wrong `aud`/`typ`
- Story: [[story-rcab-e8-s7-review-remediation-stage-ab]]

## See also
- [[integration-firebase-phone-auth]] · [[integration-google-account-link]]
- [[journey-client-otp-signup]] · [[journey-client-google-link]]
- [[entity-user]]
