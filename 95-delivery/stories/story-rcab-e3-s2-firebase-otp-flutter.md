---
title: RCAB-E3.S2 — Firebase OTP sign-in in Flutter
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e3-driver-presence]]
demo: 2
estimate: s
hitl: no
depends_on: [[story-rcab-e3-s1-flutter-app-skeleton]], [[driver-state-management]], [[rest-endpoints]], [[module-auth]]
blocks: [[story-rcab-e3-s4-driver-online-toggle]]
affected_notes: [[driver-state-management]], [[driver-flutter-structure]]
owner: claude
audience: both
---

# RCAB-E3.S2 — Firebase OTP sign-in in Flutter

## Goal

Wire up phone-number OTP sign-in on the `/sign-in` screen using `firebase_auth`. After the user verifies the SMS code, exchange the Firebase ID token with the rcab API (`POST /v1/auth/firebase-exchange`) to receive a rcab JWT + refresh token, persist them in `TokenStore`, and update `authProvider` to `authenticated`. The skeleton's auth guard then redirects the driver to `/home`. The API auth endpoints already exist from E2 — this story adds only the Flutter client side.

## User-facing acceptance criteria

- `Given` the `/sign-in` screen is open, `When` I enter a valid E.164 phone number and tap "Send OTP", `Then` Firebase sends an SMS and the screen transitions to the code-entry field.
- `Given` the code-entry field is showing, `When` I enter the correct 6-digit OTP, `Then` I am signed in to rcab and the app navigates to `/home`.
- `Given` I enter an incorrect or expired OTP, `When` I submit, `Then` an inline error message "Invalid or expired code" is shown and I can retry.
- `Given` I am already authenticated (valid JWT in `TokenStore`), `When` the app launches, `Then` it goes directly to `/home` without showing the sign-in screen.
- `Given` I tap "Sign out" from `/profile` (stub action), `When` confirmed, `Then` tokens are cleared, `authProvider` is `unauthenticated`, and the app returns to `/sign-in`.

## Technical acceptance criteria

- `lib/features/auth/sign_in_screen.dart` — phone number input (`TextFormField`, E.164 validation), "Send OTP" button, conditional SMS code input, "Verify" button. Uses `FirebaseAuth.instance.verifyPhoneNumber()` with `codeSent` and `verificationFailed` callbacks; on `PhoneAuthCredential` obtained, signs in with `FirebaseAuth.instance.signInWithCredential()`.
- After successful Firebase sign-in, calls `POST /v1/auth/firebase-exchange` via `apiClientProvider`'s dio instance with body `{ "firebase_id_token": idToken }`. On 200, passes `rcab_jwt` and `refresh_token` to `TokenStore.saveTokens()` and calls `authProvider.notifier.setAuthenticated(user)`.
- `lib/di/providers.dart` — `authProvider.setAuthenticated(User user)` transitions state to `AuthState.authenticated(user)`; `authProvider.signOut()` calls `TokenStore.clear()`, signs out of `FirebaseAuth`, and transitions to `AuthState.unauthenticated`.
- On app start, `main.dart` (or `app.dart`) performs a token-presence check: if `TokenStore.getJwt()` is non-null, sets `authProvider` to `authenticated` using the stored JWT's payload (decode without re-verify — the server will reject stale JWTs on first API call); if null, stays `unauthenticated`. The auth guard in `app_router.dart` enforces the redirect.
- `google-services.json` is expected at `android/app/google-services.json`; its presence is required for the build. The dev's Firebase project must have phone auth enabled. Document this in `apps/driver-app/README.md` (one paragraph).
- Firebase project credentials (`google-services.json`) are **not** committed to the repo — add to `.gitignore` and provide `google-services.json.example` with placeholder project ID.

## Test plan

- Unit: `test/features/auth/auth_provider_test.dart` — mock `FirebaseAuth`, mock dio; assert `unauthenticated → authenticated` transition on successful exchange; assert `authenticated → unauthenticated` on sign-out.
- Unit: assert exchange call fails → `AuthState` remains `unauthenticated`, error exposed to UI.
- Widget: `test/features/auth/sign_in_screen_test.dart` — pump `SignInScreen`; assert phone input, "Send OTP" button present; mock Firebase codeSent callback; assert code-entry field appears.
- `flutter test` must pass green.

## Out of scope

- Google account linking in the Flutter app — not needed for Demo 2.
- reCAPTCHA / web OTP handling — the driver app is Android-native, not web.
- Driver profile creation (that is managed server-side in E2; the driver row exists after `POST /v1/auth/firebase-exchange`).

## Notes / questions

- Drivers sign in with the same `POST /v1/auth/firebase-exchange` endpoint used by web clients — the API issues a JWT with `role=driver` if the user row has `role=driver`. In Phase-0, driver users are seeded manually; this story does not add a self-registration flow.
- `google-services.json.example` should include a comment explaining how to obtain the real file from the Firebase console.

## See also

- [[epic-e3-driver-presence]] · [[driver-state-management]] · [[driver-flutter-structure]] · [[driver-screens]]
- [[rest-endpoints]] · [[module-auth]] · [[story-rcab-e3-s1-flutter-app-skeleton]] · [[story-rcab-e3-s4-driver-online-toggle]]
