# Driver app — setup

## Prerequisites

- Flutter 3.22+ (`flutter --version`)
- Android Studio / Android SDK for device builds

## First-time Android project generation

The `android/` directory requires the full Gradle project tree that `flutter create`
generates. Run this once (it will not overwrite existing `lib/` or `pubspec.yaml`):

```bash
cd apps/driver-app
flutter create . --org com.rcab --platforms android
```

The generated `android/app/src/main/AndroidManifest.xml` will be overwritten —
restore it from git afterwards since it carries the required permissions:

```bash
git checkout android/app/src/main/AndroidManifest.xml
```

## Daily dev loop

```bash
# Install dependencies
flutter pub get

# Run tests
flutter test

# Static analysis
flutter analyze

# Run on connected device / emulator (dev flavor)
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000 \
            --dart-define=ENABLE_API_LOGGING=true

# Release build (prod flavor)
flutter build apk --release \
  --dart-define=API_BASE_URL=https://api.rcab.app \
  --dart-define=ENABLE_API_LOGGING=false
```

## Firebase setup

Copy `google-services.json` from the Firebase console to `android/app/`:

```bash
cp /path/to/google-services.json android/app/google-services.json
```

See `google-services.json.example` for the expected structure. Phone auth must
be enabled in the Firebase project (added in RCAB-E3.S2).
