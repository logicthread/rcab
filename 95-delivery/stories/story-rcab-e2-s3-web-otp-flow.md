---
title: RCAB-E2.S3 — Web OTP flow (reCAPTCHA + signInWithPhoneNumber)
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e2-auth]]
demo: 1
estimate: m
hitl: no
depends_on: [[web-auth-firebase]], [[integration-firebase-phone-auth]], [[story-rcab-e2-s1-otp-exchange]], [[story-rcab-e2-s2-jwt-refresh]]
affected_notes: [[web-auth-firebase]]
owner: claude
audience: both
---

# RCAB-E2.S3 — Web OTP flow (reCAPTCHA + signInWithPhoneNumber)

## Goal

A user can open the web app, enter their phone number, verify the OTP sent by Firebase, and land on the booking screen as an authenticated user. This is Demo 1's headline flow on the web client.

## User-facing acceptance criteria

- `Given` the sign-in page, `When` I enter a valid E.164 phone number and submit, `Then` reCAPTCHA runs invisibly and an OTP is sent to my phone.
- `Given` an OTP was sent, `When` I enter the correct 6-digit code, `Then` I am authenticated and redirected to `/book`.
- `Given` an incorrect OTP, `When` I submit it, `Then` I see an error and can retry.
- `Given` I am already authenticated (valid in-memory JWT or valid refresh cookie), `When` I visit `/signin`, `Then` I am redirected to `/book`.

## Technical acceptance criteria

- Firebase Web SDK initialised once in `lib/auth/firebase.ts` from `NEXT_PUBLIC_FIREBASE_*` env vars per [[web-auth-firebase]].
- `SignInPage` component: phone input → `signInWithPhoneNumber(auth, phone, appVerifier)` → OTP input → `confirmationResult.confirm(code)` → receive Firebase ID token.
- After Firebase ID token received: POST to `/v1/auth/firebase-exchange`; store rcab JWT in-memory (React context / Zustand); **discard Firebase ID token immediately**.
- Refresh token is set as HttpOnly cookie by the API (S5); web client never reads it.
- Invisible reCAPTCHA rendered on sign-in mount (`RecaptchaVerifier`, `size: "invisible"`).
- Auth context (`useAuth` hook): exposes `{ user, jwt, signOut }`; on mount reads JWT from memory, triggers silent refresh via `/v1/auth/refresh` if no JWT.
- Protected routes (`/book`, `/history`, etc.) redirect to `/signin` if `useAuth` returns no user.

## Test plan

- Unit (Vitest + Testing Library): `SignInPage` — phone submit triggers Firebase SDK call (mocked); OTP submit calls exchange endpoint (msw mock); auth context updated on success.
- Unit: `useAuth` — redirect logic for protected routes; silent refresh on mount.
- E2E (Playwright, against containerised API): full sign-in flow using Firebase emulator; land on `/book`; page reload silently re-auths via cookie.

## Notes / questions

- Playwright E2E requires Firebase Auth Emulator running in the test compose profile. Add to `docker-compose.test.yml` or mock at the network level — implementer's call; flag if non-trivial.

## Out of scope

- Google sign-in UI — that is RCAB-E2.S4.
- Native driver-app OTP — that is RCAB-E3.S2.

## See also

- [[epic-e2-auth]] · [[web-auth-firebase]] · [[integration-firebase-phone-auth]]
- [[journey-client-otp-signup]] · [[story-rcab-e2-s1-otp-exchange]] · [[story-rcab-e2-s5-cookie-csrf]]
