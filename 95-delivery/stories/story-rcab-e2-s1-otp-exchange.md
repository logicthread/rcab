---
title: RCAB-E2.S1 — OTP exchange endpoint + Firebase Admin verifier
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e2-auth]]
demo: 1
estimate: m
hitl: no
depends_on: [[module-auth]], [[integration-firebase-phone-auth]], [[rest-endpoints]], [[nestjs-structure]], [[entity-user]]
affected_notes: [[module-auth]], [[rest-endpoints]], [[nestjs-structure]]
owner: claude
audience: both
---

# RCAB-E2.S1 — OTP exchange endpoint + Firebase Admin verifier

## Goal

The first real auth endpoint: a client POSTs a Firebase ID token (obtained after phone OTP), the API verifies it with Firebase Admin, finds-or-creates the user row, and returns an rcab JWT + refresh token. This is the identity anchor for the entire app.

## User-facing acceptance criteria

- `Given` a valid Firebase ID token from a phone OTP, `When` I POST to `/v1/auth/firebase-exchange`, `Then` I receive an rcab JWT (15 min), a refresh token, and the user object.
- `Given` an invalid or expired Firebase ID token, `When` I POST to `/v1/auth/firebase-exchange`, `Then` I receive `401 invalid_firebase_token`.
- `Given` a new phone number, `When` the exchange succeeds, `Then` a new user row is created with `role=client` and `firebase_uid` set.
- `Given` a returning phone number, `When` the exchange succeeds, `Then` the existing user row is returned (no duplicate created).

## Technical acceptance criteria

- API is migrated from raw Node HTTP to NestJS 10 (AppModule bootstrap per [[nestjs-structure]]). Existing `/v1/health/live` and `/v1/health/ready` routes are preserved.
- `infra/firebase/firebase.module.ts` — initialises Firebase Admin SDK from `FIREBASE_PROJECT_ID` + `FIREBASE_SERVICE_ACCOUNT_JSON` env vars.
- `modules/auth/auth.module.ts` — NestJS module with `AuthController` and `AuthService`.
- `POST /v1/auth/firebase-exchange` validates the Firebase ID token via Admin SDK (`verifyIdToken`), enforces: `aud` matches project, `phone_number` present and E.164, `iat` within 1 hour.
- `AuthService.exchangeFirebaseToken(idToken)` — find-or-create user in Postgres; returns `{ rcab_jwt, refresh_token, user }`.
- rcab JWT shape from [[module-auth]]: `{ iss: "rcab", sub: user_id, role, auth_method: "phone", iat, exp }`, signed with `JWT_SECRET` env var, 15 min expiry.
- Refresh token: opaque UUID-v4, stored in `auth_refresh_token (token, user_id, expires_at, revoked_at)`, 30-day TTL.
- Rate limit: 10 requests/IP/minute on this endpoint (in-memory for Phase-0; Redis-backed later).

## Test plan

- Unit: `AuthService.exchangeFirebaseToken` — mock Firebase Admin; assert find-or-create logic, JWT shape, refresh token persistence.
- Unit: token validation rejects tampered token, missing `phone_number`, `aud` mismatch.
- Integration (Testcontainers Postgres): round-trip exchange creates user row + refresh token row; second call with same `firebase_uid` does not duplicate user.

## Out of scope

- Refresh and revocation — that is RCAB-E2.S2.
- Web client OTP UI — that is RCAB-E2.S3.
- Cookie issuance — that is RCAB-E2.S5.

## Notes / questions

- **NestJS migration is included in this story.** The current `apps/api/src/app.ts` is raw Node HTTP. S1 bootstraps NestJS and ports health routes before adding auth. If the migration scope feels too large, flag for impact analysis before starting.
- `FIREBASE_SERVICE_ACCOUNT_JSON` is a secrets-handling concern — the dev must set it in `.env.dev` before running. The env.example should be updated.

## See also

- [[epic-e2-auth]] · [[module-auth]] · [[integration-firebase-phone-auth]] · [[rest-endpoints]]
- [[nestjs-structure]] · [[entity-user]]
