# rcab driver app

See [SETUP.md](SETUP.md) for prerequisites, first-time Android project generation, and the daily dev loop.

## Sign-in: Google only until launch (RCAB-E8.S15)

Until launch the app signs in with **Google** only. On the sign-in screen it calls `GET /v1/auth/config` and draws only the
enabled methods (`auth.enabledMethods`, see `docs/POLICY.md`); with `['google']` there is no phone field. "Continue with
Google" uses `google_sign_in` (`serverClientId` = the web OAuth client id from that config, or the
`--dart-define=GOOGLE_SERVER_CLIENT_ID=<web client id>` fallback), then `POST /v1/auth/native/google {id_token}`. The first
sign-in registers the account; the driver role is still provisioned out of band. Sign-out also calls `GoogleSignIn.signOut()`.

The phone/OTP form and its Firebase code (`firebase_auth`) are kept behind `phone` in `auth.enabledMethods` and are not in the
login path while it is off. The OTP provider that replaces them before launch may not be Firebase.

### Google OAuth setup (owner)

1. Google Cloud Console → APIs & Services → Credentials, in the project the Firebase app belongs to: create an **OAuth client ID of
   type Web application** (this is `GOOGLE_CLIENT_IDS` on the API; the Android app requests ID tokens for it).
2. Create an **OAuth client ID of type Android** for package `com.rcab.driver_app` with the **SHA-1** of each signing key you run
   (debug: `cd android && ./gradlew signingReport`; release/Play signing key when it exists). Without it Google returns
   `ApiException: 10` / `12500`.
3. Configure the OAuth consent screen (external, publish it before launch).
4. Re-download `google-services.json` (Firebase console, Project settings) after step 2 so it carries the OAuth clients.

## Firebase setup

`firebase_core` and `firebase_messaging` (FCM) are still used, so `android/app/google-services.json` (gitignored) is still
required to build and run (`Firebase.initializeApp()` runs at start-up).

1. Open the [Firebase console](https://console.firebase.google.com), select (or create) your project, go to Project settings → Your apps → Android, add the package name `com.rcab.driver_app`, and download `google-services.json`.
2. Copy the file to `android/app/google-services.json`. Use `android/app/google-services.json.example` as a reference for the expected structure.
3. Only when phone sign-in is switched back on: enable **Phone** under Authentication → Sign-in method.

## On-device demo recordings

`integration_test/demo/` is a recording harness (test-only, nothing ships) that drives the real app on an Android
emulator against the dev stack and produces the onboarding videos in `docs/onboarding/videos/driver/`
(see its [INDEX](../../docs/onboarding/videos/driver/INDEX.md)). Run `scripts/demo/record-driver.sh [D01..D08]` from the
repo root; how it works and how to add a scene: [integration_test/demo/README.md](integration_test/demo/README.md).
