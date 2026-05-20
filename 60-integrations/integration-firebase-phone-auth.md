---
title: Integration — Firebase Phone Auth
tags: [layer/integration, kind/integration]
status: accepted
phase: 0
depends_on: [[tech-stack]]
related: [[module-auth]], [[journey-client-otp-signup]], [[web-auth-firebase]], [[ADR-0003-otp-firebase]]
audience: both
---

# Firebase Phone Auth

*OTP delivery, DLT compliance, and ID token issuance handed off to Firebase.*

## Why Firebase

See [[ADR-0003-otp-firebase]]. Short version: Firebase handles DLT registration and SMS routing for India in their free tier, fronts reCAPTCHA, and gives us a verified `phone_number` claim in an ID token we can exchange for our own JWT.

## Surfaces

| Surface | Use |
|---|---|
| Web SDK (client) | `signInWithPhoneNumber()` — sends OTP, verifies, returns ID token |
| Admin SDK (server) | `verifyIdToken(token)` — validates the token, returns `uid` + `phone_number` |

## Server-side verification

The API only trusts a Firebase ID token if:

- Signature verifies against Google's JWKs (Firebase Admin handles).
- `aud` matches our project id.
- `iat` is within the last hour (Firebase tokens are 1 h).
- `phone_number` is present and E.164-formatted.

## Limits & quotas

- Free tier covers our Phase-0 SMS volume comfortably.
- Per-phone rate limits are enforced by Firebase; we surface their error to the client verbatim.

## Failure modes

- Firebase outage → OTP signup is down. Mitigation: a Phase-0 incident playbook in [[observability]] and the option to fail open for already-authenticated users (refresh tokens still work).
- Spam abuse → reCAPTCHA blocks the worst; we additionally rate-limit `firebase-exchange` per IP.

## Migration off Firebase

If we ever migrate (e.g., cost, vendor lock-in concern), we'd add MSG91 (DLT-registered) as a parallel path, dual-route during a transition window, and finally remove Firebase. The `firebase_uid` stays as a historical identifier on user rows.

## See also
- [[module-auth]] · [[journey-client-otp-signup]] · [[web-auth-firebase]]
- [[ADR-0003-otp-firebase]]
