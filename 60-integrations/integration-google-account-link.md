---
title: Integration — Google account linking
tags: [layer/integration, kind/integration]
status: accepted
phase: 0
depends_on: [[tech-stack]]
related: [[journey-client-google-link]], [[module-auth]], [[integration-firebase-phone-auth]]
audience: both
---

# Google account linking

*Once a client has signed up via phone OTP, they may link a Google account for one-tap subsequent logins.*

## Mechanism

Two viable paths:

1. **Via Firebase** — `linkWithCredential(googleCred)` on the Firebase user. Simpler, but it ties our identity model deeper into Firebase.
2. **Direct Google OAuth 2.0** — Google Identity Services on web; backend verifies the Google ID token (signature + audience).

We choose **direct** Google OAuth in Phase-0 because Firebase Phone Auth is the only Firebase product we want to depend on; linking Google there grows the dependency. The implementation in `module-auth` verifies Google ID tokens using `google-auth-library`.

## Token verification (server)

- Signature against `https://www.googleapis.com/oauth2/v3/certs`.
- `aud` matches our client ID.
- `iss` is `https://accounts.google.com` (or `accounts.google.com`).
- `email_verified=true`.

We store the `sub` claim as `user.google_sub` (unique).

## Conflict resolution

| Situation | Behavior |
|---|---|
| Already linked to *this* user | No-op, return success |
| Already linked to *another* user | `409 google_already_linked` |
| Not linked, current user | Link, return success |

## Login via Google

`POST /v1/auth/google/login` is rejected with `404 not_found` if `google_sub` is not registered. The frontend tells the user to sign in via phone first (which prompts a link).

## See also
- [[journey-client-google-link]] · [[module-auth]]
- [[integration-firebase-phone-auth]]
