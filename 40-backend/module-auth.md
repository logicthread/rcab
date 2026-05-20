---
title: Module — auth
tags: [layer/backend, kind/module]
status: accepted
phase: 0
depends_on: [[nestjs-structure]]
related: [[integration-firebase-phone-auth]], [[integration-google-account-link]], [[journey-client-otp-signup]], [[journey-client-google-link]], [[entity-user]]
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
  sub: "<user_id>",
  role: "client" | "driver",
  auth_method: "phone" | "google",
  iat, exp (15 min)
}
```

Refresh tokens are opaque strings stored in Postgres `auth_refresh_token (token, user_id, expires_at, revoked_at)`.

## Internal collaborators

- `infra/firebase` — Firebase Admin SDK
- `users` module — to find-or-create user rows

## Tests

- Unit: token verification mocking the Firebase SDK
- Integration: round-trip OTP exchange + refresh
- Negative: tampered token, expired token, replayed refresh

## See also
- [[integration-firebase-phone-auth]] · [[integration-google-account-link]]
- [[journey-client-otp-signup]] · [[journey-client-google-link]]
- [[entity-user]]
