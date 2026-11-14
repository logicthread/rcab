# rcab driver app

See [SETUP.md](SETUP.md) for prerequisites, first-time Android project generation, and the daily dev loop.

## Firebase setup

The driver app uses Firebase phone authentication. You must supply a `google-services.json` file (excluded from the repo) to build successfully.

1. Open the [Firebase console](https://console.firebase.google.com), select (or create) your project, and enable **Phone** under Authentication → Sign-in method.
2. Go to Project settings → Your apps → Android, add the package name `com.rcab.driver_app`, and download `google-services.json`.
3. Copy the file to `android/app/google-services.json` (it is gitignored). Use `android/app/google-services.json.example` as a reference for the expected structure.

## On-device demo recordings

`integration_test/demo/` is a recording harness (test-only, nothing ships) that drives the real app on an Android
emulator against the dev stack and produces the onboarding videos in `docs/onboarding/videos/driver/`
(see its [INDEX](../../docs/onboarding/videos/driver/INDEX.md)). Run `scripts/demo/record-driver.sh [D01..D08]` from the
repo root; how it works and how to add a scene: [integration_test/demo/README.md](integration_test/demo/README.md).
