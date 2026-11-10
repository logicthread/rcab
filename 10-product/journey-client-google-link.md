---
title: Journey — Client Google account linking
tags: [layer/product, kind/journey]
status: accepted
phase: 0
depends_on: [[journey-client-otp-signup]], [[ADR-0003-otp-firebase]]
related: [[integration-google-account-link]], [[module-auth]], [[entity-user]]
audience: both
---

# Client Google sign-in, registration & linking

> **Adjusted 2026-11-10 (RCAB-E8.S15):** Google is now the primary and only enabled entry point until launch ([[ADR-0003-otp-firebase]] amendment). First-time users **register** by signing in with Google (role `client`, no phone needed); returning users sign in by `google_sub`. Flows A and B below describe the earlier phone-first model and apply only when `phone` is re-enabled.

## Flow 0 — Google sign-in / register (current)

1. Client opens the app; `GET /v1/auth/config` says which methods to render (`google` only).
2. User taps "Sign in with Google"; the client obtains a Google ID token and calls `POST /v1/auth/google` (web) or `POST /v1/auth/native/google` (driver app).
3. Backend verifies the token with Google (`email_verified=true`), logs in by `google_sub`, or registers a new `client` user. Never auto-linked by email.
4. Errors: 401 `google_token_invalid`, 403 `google_email_unverified`, 503 `google_not_configured`, 403 `account_disabled`.
5. Drivers: the driver role is provisioned out of band; a driver account is provisioned out of band and must have its `google_sub` set the same way, since there is no email auto-link (open question tracked in [[story-rcab-e8-s15-google-only-sign-in]]).

*After phone OTP, a client can attach a Google account so subsequent logins are one-tap.*

## Flow A — link from settings (post-OTP)

1. User is already authenticated via phone.
2. Settings → "Connect Google" → opens Google OAuth (web).
3. Frontend receives Google ID token; calls `POST /auth/google/link` with current rcab JWT + Google ID token.
4. Backend verifies Google ID token, stores `google_sub` on the user row (unique).
5. From now on, the user can log in via Google.

## Flow B — login via Google (returning user)

1. User clicks "Sign in with Google".
2. Frontend receives Google ID token; calls `POST /auth/google/login`.
3. Backend verifies token, looks up user by `google_sub`. If found, issues rcab JWT.
4. If **not** found, the response asks the user to first sign in via phone OTP (which will then prompt them to link). We do **not** create a phone-less account via Google alone.

## Why "phone-first, then optional Google"

- Phone is the only verified identifier we trust for a fresh customer in this market.
- Google sign-in alone gives us no phone number; drivers need to reach clients by phone.
- Once linked, the convenience benefit is real and we surface "Connect Google" prominently.

## Conflict handling

- If a Google account is presented for linking and `google_sub` already exists on a different user, reject with `409 google_already_linked`. The user must unlink on the other account first or contact support.

## See also
- [[integration-google-account-link]] · [[journey-client-otp-signup]]
- [[module-auth]] · [[entity-user]]
