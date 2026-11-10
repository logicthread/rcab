---
title: Web client — Firebase auth integration
tags: [layer/client-web]
status: accepted
phase: 0
depends_on: [[integration-firebase-phone-auth]]
related: [[journey-client-otp-signup]], [[journey-client-google-link]], [[module-auth]]
audience: both
---

# Web client — Firebase auth integration

> **Suspended 2026-11-10 (RCAB-E8.S15):** the web app signs in with Google only (Google Identity Services -> `POST /v1/auth/google`; it reads `GET /v1/auth/config` and `NEXT_PUBLIC_GOOGLE_CLIENT_ID`). The Firebase OTP flow below is kept for when `phone` is re-enabled ([[ADR-0003-otp-firebase]] amendment).

*Firebase Web SDK for OTP + Google sign-in. Tokens never persist beyond the exchange.*

## Initialization

- Firebase web SDK initialized once in `lib/auth/firebase.ts`.
- Config from `NEXT_PUBLIC_FIREBASE_*` envs. Public values, safe to expose.

## OTP flow on web

- Render an invisible reCAPTCHA on the OTP screen (`signInWithPhoneNumber`).
- On verify, we receive a Firebase ID token in memory.
- POST it to `/v1/auth/firebase-exchange` and **immediately discard** the Firebase ID token.

## rcab JWT storage

- Access token: in-memory only.
- Refresh token: HttpOnly, Secure, SameSite=Lax cookie. Issued by the API on exchange, sent automatically on refresh.

Rationale: keeps the access token out of XSS reach; refresh cookie is HttpOnly so JS can't read it.

## Google sign-in

- `signInWithPopup(googleProvider)` on supported browsers; `signInWithRedirect` fallback on iOS where popups are flaky.
- The Google ID token is sent to either `/v1/auth/google/link` (when authenticated) or `/v1/auth/google/login` (when not).

## See also
- [[integration-firebase-phone-auth]] · [[integration-google-account-link]]
- [[journey-client-otp-signup]] · [[journey-client-google-link]] · [[module-auth]]
