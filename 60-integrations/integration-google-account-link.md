---
title: Integration — Google account linking
tags: [layer/integration, kind/integration]
status: accepted
phase: 0
depends_on: [[tech-stack]]
related: [[journey-client-google-link]], [[module-auth]], [[integration-firebase-phone-auth]]
audience: both
---

# Google sign-in and account linking

> **Updated 2026-11-10 (RCAB-E8.S15):** Google is now the **only enabled sign-in and registration method** until launch ([[ADR-0003-otp-firebase]] amendment). The ID token is verified directly with Google; Firebase Auth is not used. The linking flow below only applies when `phone` is re-enabled.

## Google-only sign-in (current)

- Public `GET /v1/auth/config` returns `{methods:["google"], google:{clientId}}`; clients render only enabled methods.
- Web: `POST /v1/auth/google` `{id_token}` sets the HttpOnly refresh cookie (CSRF like `/refresh`). Native: `POST /v1/auth/native/google` returns the native token shape (no cookie).
- Any Google account (Gmail or Workspace) with `email_verified=true` is accepted. Audience must be one of `GOOGLE_CLIENT_IDS` (the Android app sends the web client id as `serverClientId`, so usually a single id; `GOOGLE_CLIENT_ID` is a back-compat alias). With none configured the endpoint returns 503 `google_not_configured` (the API still boots).
- Login is by `google_sub`. An unknown `google_sub` **registers** a new `client` user (storing `google_sub` and the verified email). **Never auto-linked by email** to an existing account. The driver role is still provisioned out of band.
- Suspended/deleted accounts get 403 `account_disabled`; `auth_method` is `google`.
- Errors: 401 `google_token_invalid`, 403 `google_email_unverified`, 503 `google_not_configured`, 403 `auth_method_disabled` (see [[error-codes]]).
- Legacy endpoints: `POST /v1/auth/google/login` is folded into `POST /v1/auth/google` (login-or-register, so no 404 for an unknown sub); `POST /v1/auth/google/link` is kept for the phone-enabled era (documented in [[rest-endpoints]]).

## Linking (applies only when `phone` is enabled)

*Once a client has signed up via phone OTP, they may link a Google account for one-tap subsequent logins.*

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
- `email_verified=true` (else 403 `google_email_unverified`).

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
