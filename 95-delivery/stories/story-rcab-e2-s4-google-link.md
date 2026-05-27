---
title: RCAB-E2.S4 — Google link/login endpoints + ID-token verify
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e2-auth]]
demo: 1
estimate: s
hitl: no
depends_on: [[integration-google-account-link]], [[module-auth]], [[rest-endpoints]], [[story-rcab-e2-s1-otp-exchange]]
affected_notes: [[module-auth]], [[rest-endpoints]], [[integration-google-account-link]]
owner: claude
audience: both
---

# RCAB-E2.S4 — Google link/login endpoints + ID-token verify

## Goal

After signing in via phone OTP, a user can link their Google account for one-tap future logins. The server verifies Google ID tokens directly (not via Firebase) using `google-auth-library`.

## User-facing acceptance criteria

- `Given` an authenticated user (JWT present), `When` I complete Google sign-in on the web and POST the Google ID token to `/v1/auth/google/link`, `Then` my Google account is linked and I receive `200`.
- `Given` the Google account is already linked to my account, `When` I POST to `/v1/auth/google/link` again, `Then` I receive `200` (no-op).
- `Given` the Google account is linked to a different user, `When` I POST to `/v1/auth/google/link`, `Then` I receive `409 google_already_linked`.
- `Given` a linked Google account, `When` I POST to `/v1/auth/google/login`, `Then` I receive an rcab JWT + refresh token.
- `Given` an unregistered Google account (no matching `google_sub`), `When` I POST to `/v1/auth/google/login`, `Then` I receive `404 not_found`.

## Technical acceptance criteria

- `google-auth-library` added to `apps/api` deps. `OAuth2Client.verifyIdToken()` used for all Google ID token verification.
- Google ID token verified per [[integration-google-account-link]]: signature against Google JWKs, `aud` matches `GOOGLE_CLIENT_ID` env var, `iss` in `{accounts.google.com, https://accounts.google.com}`, `email_verified=true`.
- `POST /v1/auth/google/link` 🔒 — body `{ google_id_token }`; sets `user.google_sub` and `user.email`; handles the three conflict cases.
- `POST /v1/auth/google/login` — body `{ google_id_token }`; looks up user by `google_sub`; returns tokens on match, `404` on no match.
- `AuthService.linkGoogle(userId, googleIdToken)` and `AuthService.loginWithGoogle(googleIdToken)` per [[module-auth]].
- Web client: `signInWithPopup(googleProvider)` on desktop; `signInWithRedirect` fallback for iOS popup restrictions, per [[web-auth-firebase]].

## Test plan

- Unit: `AuthService.linkGoogle` — mock `OAuth2Client`; assert all three conflict scenarios.
- Unit: `AuthService.loginWithGoogle` — `google_sub` found returns tokens; not found returns appropriate error.
- Unit: token verification rejects invalid signature, wrong `aud`, `email_verified=false`.
- Integration (Testcontainers Postgres): OTP exchange → link Google → login via Google; verify `google_sub` persisted on user row.

## Out of scope

- Google sign-in as primary auth (no OTP) — not supported in Phase-0.
- Firebase-based Google linking — we use direct OAuth per [[integration-google-account-link]].

## See also

- [[epic-e2-auth]] · [[integration-google-account-link]] · [[module-auth]] · [[rest-endpoints]]
- [[journey-client-google-link]] · [[story-rcab-e2-s1-otp-exchange]]
