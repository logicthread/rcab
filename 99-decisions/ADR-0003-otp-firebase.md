---
title: ADR-0003 — OTP via Firebase Phone Auth (amended 2026-11-10 — Google-only until launch)
tags: [layer/decision, kind/adr]
status: accepted (amended 2026-11-10)
phase: 0
related: [[integration-firebase-phone-auth]], [[integration-google-account-link]], [[module-auth]]
audience: both
---

# ADR-0003 — OTP via Firebase Phone Auth, with Google linking on top

> **Amended 2026-11-10 — Google-only sign-in until launch.** Sign-in and registration are Google OAuth only until launch; the phone/OTP path described below is retained but disabled. See [Amendment 2026-11-10](#amendment-2026-11-10--google-only-sign-in-until-launch).

*Phone OTP delivery and verification handled by Firebase; optional Google linking provided via direct Google OAuth.*

- **Status:** accepted (amended 2026-11-10; original decision history kept below)
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

## Amendment 2026-11-10 — Google-only sign-in until launch

*Owner decision, approved explicitly (HITL). The original decision above is kept as history; where they conflict, this section wins until the revisit trigger fires.*

### Decision

- Until launch, sign-in **and registration** use **Google OAuth only**, in both the web and driver apps. Any Google account (Gmail or Workspace) is accepted if Google reports `email_verified=true`.
- The Google ID token is verified **directly with Google** (`google-auth-library`, audience = `GOOGLE_CLIENT_IDS`). Firebase Auth is **out of the login path**.
- Phone OTP is **disabled, not deleted**, behind the central policy knob `auth.enabledMethods` (env `AUTH_ENABLED_METHODS`, comma list over `{google, phone}`, default `google`). While `phone` is not enabled, the Firebase exchange endpoints return 403 `auth_method_disabled`.
- Login is by `google_sub`. An unknown `google_sub` registers a new user with role `client`. There is no auto-link by email to an existing account.

### Reasons

- The OTP provider for launch is **undecided and may not be Firebase** (MSG91, another vendor, or Firebase).
- Avoids DLT / SMS-sender setup before launch.
- Keeps the provider slot clean: the phone path stays behind one flag, so a future provider is a drop-in.

### Consequences

- Phone is **optional** on a user: migration `0018_app_user_google_identity.sql` makes `app_user.phone_e164` nullable with `CHECK (phone_e164 IS NOT NULL OR google_sub IS NOT NULL)`; `google_sub` unique; `email` column ensured.
- New policy knob `auth.enabledMethods` (see [[POLICY]] generated overview); new public `GET /v1/auth/config` tells clients which methods to render.
- New endpoints `POST /v1/auth/google` (web) and `POST /v1/auth/native/google`; new error codes `google_token_invalid`, `google_email_unverified`, `google_not_configured`, `auth_method_disabled` (see [[error-codes]]).
- **FCM is unaffected** (push is a separate Firebase product; only Firebase *Auth* leaves the login path).
- The **driver role is still provisioned out of band**; Google sign-in only creates `client` users.
- Accepted risk: no phone number on Google-registered users, so phone-based contact/anti-abuse signals are unavailable until OTP returns.

### Revisit trigger

Choose the launch OTP provider (Firebase, MSG91 or another), implement it behind the existing phone slot, and re-enable `phone` in `auth.enabledMethods`. That decision supersedes or further amends this ADR.

Tracked by [[story-rcab-e8-s15-google-only-sign-in]].

## See also
- [[integration-firebase-phone-auth]] · [[integration-google-account-link]]
- [[module-auth]] · [[journey-client-otp-signup]] · [[journey-client-google-link]]
