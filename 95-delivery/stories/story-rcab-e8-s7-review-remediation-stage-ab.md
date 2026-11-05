---
title: RCAB-E8.S7 — Review remediation Stage A+B (runtime, config, sessions, booking, idempotency)
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S7
demo: 7
estimate: l
hitl: yes
depends_on: [[story-rcab-e2-s2-jwt-refresh]], [[story-rcab-e2-s5-cookie-csrf]], [[story-rcab-e4-s2-quote-request-endpoints]]
blocks:
affected_notes: [[module-auth]], [[module-rides]], [[rest-endpoints]], [[security-checklist]], [[schema-postgres]]
owner: claude
audience: both
---

# RCAB-E8.S7 — Review remediation Stage A+B

## Goal

An external repository review produced 18 findings (F01-F18). Stage A+B fixes the ones that break a running system or its sessions: the production artifact missing Lua scripts, the dev runner losing DI metadata, unsafe production config, a self-cancelling web quote, refresh/logout/suspension gaps, the missing native session contract, and cross-account idempotency replay. Work is on branch `remediation/stage-a-b` (slices `rem/runtime-config`, `rem/api-auth`, `rem/api-idempotency`, `rem/web`, `rem/flutter`). Status stays `in_progress`: done requires the HITL sign-off below.

## User-facing acceptance criteria

- F01 — Given a valid route, When the booking page quotes, Then the quote resolves (no self-cancel on `stage` change); Retry re-quotes an unchanged route; a label-only reverse-geocode keeps the quote. *Test:* web quote-effect specs (delayed success/error, route change, retry).
- F18 — Given a booking retry or an expired access token, Then the same `Idempotency-Key` is reused per booking intent (rotated on change/success), token refresh is single-flight, one 401 retry runs, and socket reconnects use a fresh token. *Test:* web booking/auth-refresh specs.
- F12 (web) — Given Sign out, Then `POST /v1/auth/logout` is called and local credentials cleared. *Test:* web signOut spec.
- F12 (server) — Given a suspended/deleted user, Then phone exchange and Google login return 403 `account_disabled`, refresh returns 401 `account_disabled` and revokes the user's refresh tokens. Given a consumed token replayed, Then its whole family is revoked. Given two concurrent refreshes, Then exactly one succeeds. *Test:* `auth.service.spec.ts`, `auth.int.spec.ts` (race, replay, status).
- F02 — Given the Flutter driver app, Then it uses `/v1/auth/native/*` (no cookies/CSRF) with fixtures matching the API. *Test:* `native-auth-contract.json` asserted by `auth.controller.spec.ts` and `auth.int.spec.ts`; Flutter contract tests (`rem/flutter`).
- F07 / F15 (idempotency half) — Given the same key from two accounts, Then each gets an independent ride; same scope + different intent returns 422 `idempotency_key_conflict`; a retried identical shared create replays the original seat; concurrent duplicate returns 409 `idempotency_request_in_progress`. *Test:* `rides.idempotency.spec.ts`, `rides-idempotency.int.spec.ts` (incl. cold-cache replay).

## Technical acceptance criteria

- F03 — `pnpm --filter @rcab/api build` copies dispatch/matching Lua into `dist` and fails if absent; `test:artifact` loads compiled services against `dist`; `Dockerfile.prod` runs the same check.
- F04 — dev runner is `node --watch` + SWC require hook emitting `design:paramtypes`; `test:dev-loader` proves `RidesController` receives `PricingService` (fails under tsx).
- F11 — `JWT_SECRET` fallback only when `NODE_ENV` is `development`/`test`; elsewhere (including unset) missing/placeholder/<32-byte/repetitive secret aborts startup. Access tokens carry `iss=rcab`, `aud=rcab-api`, `typ=access`, HS256, verified by `verifyAccessToken()` in `AuthGuard` and the realtime gateway. `CORS_ORIGINS` (alias `ALLOWED_ORIGINS`) required, https-only, no wildcard outside dev/test; drives CORS and `CsrfGuard` (Origin, then Referer). `api.env.example` lists what the API reads (pinned by a unit test). *Test:* `auth-config.spec.ts`, `access-token.spec.ts`, `csrf.guard.spec.ts`, `firebase-admin.service.spec.ts`.
- F12 — refresh tokens are 256-bit random values stored as SHA-256 digests; migration `0012_refresh_token_hash.sql` hashes legacy rows, adds `family_id` + `auth_method`, drops the plaintext column. *Test:* migration 0012 on legacy rows in `auth.int.spec.ts`.
- F07 — migration `0013_idempotency_scope.sql`: `rides.idempotency_operation`, `rides.request_fingerprint`, composite UNIQUE (replacing the global one), `idempotency_record` table. Redis `idem:rides:*` removed.
- F13 — web prod image takes `NEXT_PUBLIC_*` as build args and fails the build when missing/localhost (compose, prod-test, Jenkins).
- F14 (root tsc only) — Jenkins type-checks every workspace instead of the config-less root `tsc`.
- F16 — `computeStops` ranks dropoffs by destination coordinates; typed numeric env helper (`common/utils/env.ts`) used for all non-auth numeric config. *Test:* `dispatch.service.spec.ts`, `pricing.service.spec.ts`, `env.spec.ts`.

## Test plan

- Unit: auth-config, access-token, csrf.guard, auth.service/controller, firebase-admin, env, dispatch, pricing, rides.idempotency; web specs.
- Integration (Testcontainers): `auth.int.spec.ts`, `rides-idempotency.int.spec.ts`, drivers/vehicles (typed tokens).
- Artifact: `test:artifact`, `test:dev-loader`.
- Gate: `pnpm verify` (never with `RCAB_SKIP_INT=1`).

## HITL stops

- Apply migrations 0012 and 0013 to any long-lived DB (0012 drops the plaintext token column; existing sessions survive via in-place hashing).
- Sign-off walk: web sign-in, quote, book (solo + shared), retry, sign out; driver app native sign-in/refresh. Nothing is marked done without it.
- Secrets-handling and ADR follow-ups (see Notes) need explicit approval; this story edits neither.

## Out of scope (deferred)

- Stage C: F05 offer authorization, F06 one-ride-per-driver, F08 lost dispatch work (TODOs mark idempotency replay paths), F09 pool membership consistency, F10 shared realtime/acceptance.
- Stage D/E: F14 deploy pipeline (immutable image deploy, remote version assertion, rollback), F15 shared-fare ambiguity, F17 metrics/load evidence.

## Notes / questions

Open decisions from the remediation guide section 3 (defaults proposed, none authorized): web/mobile refresh transport (cookie vs native endpoint, now implemented as proposed); logout scope and "log out everywhere"; refresh-replay grace (implemented strict, no grace); signing (kept HS256); offer validity and driver exclusivity (Stage C); pool seats model; shared fare policy; scheduled dispatch window (T-10 min wake vs 4-min acceptance note vs 60 s default); realtime delivery protocol; Redis recovery and RPO; browser public config (build-time args chosen for now); pilot scope (which ride types and screens are enabled). Owner decisions still open: shared-member cancellation/no-show, early driver assignment for scheduled trips, pickup lateness, account switching mid-ride, fare change after itinerary change, location/identity data retention. The shared-create `Idempotency-Key` header stays optional until the web client sends it everywhere.

## See also
- [[epic-e8-production-hardening]] · [[stories-index]] · [[hitl-touchpoints]] · [[impact-analysis]]
- [[module-auth]] · [[module-rides]] · [[rest-endpoints]] · [[security-checklist]] · [[schema-postgres]]
