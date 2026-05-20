---
title: Journey — Client Google account linking
tags: [layer/product, kind/journey]
status: accepted
phase: 0
depends_on: [[journey-client-otp-signup]]
related: [[integration-google-account-link]], [[module-auth]], [[entity-user]]
audience: both
---

# Client Google account linking & login

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
