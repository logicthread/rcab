---
title: RCAB-E2.S6 — Auth integration tests + negative cases
tags: [layer/delivery, kind/story]
status: ready
phase: 0
epic: [[epic-e2-auth]]
demo: 1
estimate: s
hitl: no
depends_on: [[testing-strategy]], [[module-auth]], [[story-rcab-e2-s1-otp-exchange]], [[story-rcab-e2-s2-jwt-refresh]], [[story-rcab-e2-s4-google-link]], [[story-rcab-e2-s5-cookie-csrf]]
affected_notes: [[testing-strategy]]
owner: claude
audience: both
---

# RCAB-E2.S6 — Auth integration tests + negative cases

## Goal

A comprehensive integration test suite covering the complete auth surface — happy paths, negative cases, and security invariants — giving confidence to ship Demo 1.

## User-facing acceptance criteria

- `Given` the auth test suite, `When` it runs in CI, `Then` it passes green against a real Postgres container (no mocks of DB or token issuance).

## Technical acceptance criteria

Coverage per [[testing-strategy]] ("100% of state-machine transitions, positive and negative"):

**Happy paths (Testcontainers Postgres):**
- OTP exchange → JWT + refresh token returned; user row created.
- Returning user exchange → existing row returned, no duplicate.
- Refresh → new JWT; old refresh token revoked; new token stored.
- Logout → refresh token revoked; subsequent refresh 401.
- Google link → `google_sub` set on user.
- Google login → JWT issued for linked user.

**Negative cases:**
- Tampered Firebase ID token → `401 invalid_firebase_token`.
- Expired Firebase ID token (mock `iat` to `now() - 2h`) → `401`.
- Firebase token with missing `phone_number` → `401`.
- Replayed refresh token (used twice) → second call returns `401`.
- Revoked refresh token → `401`.
- Google login for unregistered `google_sub` → `404 not_found`.
- Google link conflict (same `google_sub`, different user) → `409 google_already_linked`.
- Authenticated endpoint without JWT → `401 unauthorized`.
- Authenticated endpoint with expired JWT → `401 unauthorized`.

**CSRF / cookie tests:**
- Refresh via cookie (no body) → succeeds.
- Cross-origin `Origin` header on `/v1/auth/refresh` → `403`.

## Test plan

- Integration (Vitest + `@testcontainers/postgresql`): all cases above in `test/integration/auth.int.spec.ts`.
- Firebase Admin is mocked at the SDK boundary (interface mock, not network). Google `OAuth2Client` is similarly mocked.
- Test helper `createTestUser(phone)` bootstraps a user row directly via Drizzle for tests that don't need the full exchange flow.

## Out of scope

- E2E Playwright tests for the web OTP UI — those are in RCAB-E2.S3.
- Load testing auth paths — deferred to E8.

## See also

- [[epic-e2-auth]] · [[testing-strategy]] · [[module-auth]]
- [[story-rcab-e2-s1-otp-exchange]] · [[story-rcab-e2-s2-jwt-refresh]]
- [[story-rcab-e2-s4-google-link]] · [[story-rcab-e2-s5-cookie-csrf]]
