---
title: RCAB-E8.S15 — Google-only sign-in and registration until launch
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S15
demo: 7
estimate: l
hitl: yes
depends_on: [[story-rcab-e8-s10-central-policy-config]], [[ADR-0003-otp-firebase]]
blocks:
affected_notes: [[module-auth]], [[integration-google-account-link]], [[integration-firebase-phone-auth]], [[journey-client-otp-signup]], [[journey-client-google-link]], [[rest-endpoints]], [[error-codes]], [[security-checklist]], [[entity-user]]
owner: claude
audience: both
---

# RCAB-E8.S15 — Google-only sign-in and registration until launch

## Goal

Owner decision 2026-11-10: until launch, sign-in and registration use Google OAuth only, in the web and driver apps. The launch OTP provider is undecided and may not be Firebase, and we want to avoid DLT/SMS setup pre-launch. Phone OTP is disabled (not deleted) behind the central policy knob `auth.enabledMethods`, leaving a clean slot for the future provider. [[ADR-0003-otp-firebase]] is amended in place (HITL approved by the owner).

## User-facing acceptance criteria

- Given the web sign-in page, When it loads, Then it shows only the methods from `GET /v1/auth/config` (Google only) and a Google sign-in button.
- Given a person with any Google account (Gmail or Workspace) whose email Google reports verified, When they sign in for the first time, Then a `client` account is registered and they are signed in.
- Given a returning Google user, When they sign in, Then they land in the same account (matched by `google_sub`).
- Given the driver app, When a provisioned driver signs in, Then Google sign-in is used and the OTP screen is not shown.
- Given an unverified Google email, When signing in, Then access is refused with a clear message.

## Technical acceptance criteria

- Policy `auth.enabledMethods` (env `AUTH_ENABLED_METHODS`, default `google`, at least one of `google`, `phone`); `docs/POLICY.md` regenerated (`pnpm policy:doc`).
- `GET /v1/auth/config` public -> `{methods, google:{clientId}}`. `GOOGLE_CLIENT_IDS` (alias `GOOGLE_CLIENT_ID`); unset in dev -> 503 `google_not_configured`, no boot crash.
- `POST /v1/auth/google` (web, cookie, CSRF like refresh) and `POST /v1/auth/native/google`: login by `google_sub`, else register role `client` with verified email; never auto-link by email; suspended/deleted -> 403 `account_disabled`; `auth_method` `google`.
- With `phone` not enabled, both `firebase-exchange` routes -> 403 `auth_method_disabled`.
- Migration `0018_app_user_google_identity.sql`: `phone_e164` nullable, `CHECK (phone_e164 IS NOT NULL OR google_sub IS NOT NULL)`, unique `google_sub`, `email` column; `schema.ts` and fixtures (`native-auth-contract.json` plus a google section, mirrored in `apps/driver-app/test/fixtures`).
- Error codes `google_token_invalid` (401), `google_email_unverified` (403), `google_not_configured` (503), `auth_method_disabled` (403) in [[error-codes]].
- `google/login` is folded into `google`; `google/link` kept for the phone-enabled era.

## Test plan

- Unit: Google verifier (audience list, issuer, `email_verified`), policy parsing, method gating, register vs login.
- Integration: Testcontainers round trip for web and native Google, never-auto-link by email, suspended account, migration 0018 constraints, `auth_method_disabled`.
- Contract: native fixture parity (api and driver app).
- E2E: web sign-in page renders Google only; driver-app widget test for the sign-in screen.

## HITL stops

- Auth and security code: owner approved this change and the ADR-0003 amendment.
- `80-infrastructure/secrets-management.md` is not edited in this story; the owner updates it (see notes).
- Owner creates the Google OAuth clients (web and Android); see [[ADR-0003-otp-firebase]] amendment and `docs/manual-testing/RUN-GUIDE.md` section 0.

## Out of scope

- Choosing or implementing the launch OTP provider (revisit trigger in the ADR amendment).
- Self-registration of drivers (still out of band).
- Removing the phone/OTP code or Firebase Cloud Messaging changes.

## Notes / questions

- `firebase_uid` is `NOT NULL UNIQUE` today; Google-registered users have none. Confirm how migration 0018 handles it.
- Drivers provisioned out of band need a `google_sub` set the same way, since email auto-link is forbidden.
- Existing demo recordings W02 and D01 show the phone flow until re-recorded.
- Needed `secrets-management` changes (owner): document `GOOGLE_CLIENT_IDS` as public config (not a secret), `NEXT_PUBLIC_GOOGLE_CLIENT_ID` build-time var, `GOOGLE_SERVER_CLIENT_ID` driver build define, and that Firebase Admin credentials are no longer on the login path (still needed for FCM).

## See also

- [[epic-e8-production-hardening]] · [[story-rcab-e8-s10-central-policy-config]] · [[story-rcab-e8-s14-team-onboarding-pack]]
- [[ADR-0003-otp-firebase]] · [[module-auth]] · [[integration-google-account-link]] · [[integration-firebase-phone-auth]]
- [[journey-client-google-link]] · [[journey-client-otp-signup]] · [[rest-endpoints]] · [[error-codes]] · [[security-checklist]] · [[entity-user]]
