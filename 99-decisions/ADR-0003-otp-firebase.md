---
title: ADR-0003 — OTP via Firebase Phone Auth
tags: [layer/decision, kind/adr]
status: accepted
phase: 0
related: [[integration-firebase-phone-auth]], [[integration-google-account-link]], [[module-auth]]
audience: both
---

# ADR-0003 — OTP via Firebase Phone Auth, with Google linking on top

*Phone OTP delivery and verification handled by Firebase; optional Google linking provided via direct Google OAuth.*

- **Status:** accepted
- **Date:** 2026-05-19
- **Phase:** 0

## Context

India requires DLT registration for SMS senders. Phase-0 wants no operational burden around SMS routing. The user must be reachable by phone — phone is the primary identifier — and Google sign-in should be available as a convenience after a phone-verified signup.

## Decision

- Use **Firebase Phone Auth** for OTP delivery and ID token issuance.
- Exchange the Firebase ID token once at the backend for an rcab JWT + refresh token.
- For Google sign-in, use **direct Google OAuth** (not Firebase's Google provider) to avoid widening our Firebase dependency.
- `google_sub` is stored on the user row; only users with a phone-verified account can link.

## Consequences

- Positive
  - Zero ops burden on SMS routing in Phase-0.
  - Firebase handles reCAPTCHA, DLT, regional routing.
  - We retain identity ownership — our JWT is the only token clients use after the exchange.
- Negative
  - Vendor lock-in to Firebase for OTP (migratable; see [[integration-firebase-phone-auth]] §Migration).
  - Two IdPs to maintain (Firebase + Google OAuth).
- Neutral
  - Cost: free tier covers Phase-0.

## Alternatives considered

- **MSG91** — DLT-compliant, India-local; we'd manage templates and quotas ourselves. Better long-term, more work for Phase-0.
- **Twilio Verify** — globally strong; India delivery and cost are weaker than MSG91.
- **Pluggable / defer** — added abstraction overhead without immediate benefit.

## See also
- [[integration-firebase-phone-auth]] · [[integration-google-account-link]]
- [[module-auth]] · [[journey-client-otp-signup]] · [[journey-client-google-link]]
