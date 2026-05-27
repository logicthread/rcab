---
title: Driver app — Flutter structure
tags: [layer/client-driver]
status: accepted
phase: 0
depends_on: [[tech-stack]]
related: [[driver-screens]], [[driver-state-management]], [[driver-background-location]], [[driver-google-maps-handoff]], [[driver-push-notifications]]
audience: both
---

# Driver app — Flutter structure

*Flutter 3.x. Android-only for Phase-0 (iOS deferred). One Dart app, layered.*

## Folder layout (inside `apps/driver-app/`)

```
apps/driver-app/
  lib/
    main.dart
    app.dart                 # Root widget, theming, router
    core/
      api/                   # generated client (OpenAPI or hand-written)
      auth/                  # token store, refresh interceptor
      realtime/              # Socket.IO client
      location/              # background service wrapper
      fcm/                   # token registration, handlers
      logger/
    features/
      auth/                  # phone OTP via Firebase
      home/                  # online toggle, dashboard summary
      offer/                 # incoming ride offer UI
      ride/                  # active ride screen
      earnings/              # dashboard
      profile/
      shared/                # common widgets
    routing/
      app_router.dart        # go_router
    di/
      providers.dart         # Riverpod providers
  android/                   # FOREGROUND_SERVICE config, FCM, manifest
  ios/                       # placeholder for Phase-1
  test/                      # unit + widget tests
  integration_test/
```

## Key packages

| Package | Purpose |
|---|---|
| `flutter_riverpod` | DI + state |
| `go_router` | Routing |
| `dio` | HTTP client (with refresh interceptor) |
| `socket_io_client` | Realtime |
| `firebase_auth` | Phone OTP |
| `firebase_messaging` | FCM |
| `flutter_foreground_task` | Foreground service for location (Android) |
| `geolocator` | Location samples |
| `freezed` + `json_serializable` | Models |
| `flutter_local_notifications` | Heads-up notifications |
| `url_launcher` | Google Maps deeplink |
| `flutter_secure_storage` | JWT + refresh token persistence |
| `permission_handler` | Runtime permission requests + OEM battery settings |
| `shared_preferences` | Lightweight flags (e.g. OEM onboarding shown) |

## Why Riverpod

- Compile-time-safe, testable, doesn't need build context.
- Works well with code-gen DTOs and async streams (WS, location).

## Build flavors

- `dev` — points at staging API, mocked FCM, debug logging.
- `prod` — release build, ProGuard rules for `socket_io_client`, no debug bridge.

## See also
- [[driver-screens]] · [[driver-state-management]]
- [[driver-background-location]] · [[driver-google-maps-handoff]] · [[driver-push-notifications]]
- [[ADR-0006-flutter-driver-app]]
