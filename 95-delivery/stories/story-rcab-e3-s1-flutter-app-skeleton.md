---
title: RCAB-E3.S1 — Flutter app skeleton: routing, theme, Riverpod, dio + refresh
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e3-driver-presence]]
demo: 2
estimate: m
hitl: no
depends_on: [[driver-flutter-structure]], [[driver-screens]], [[driver-state-management]], [[rest-endpoints]], [[ADR-0006-flutter-driver-app]]
blocks: [[story-rcab-e3-s2-firebase-otp-flutter]], [[story-rcab-e3-s3-vehicle-registration]]
affected_notes: [[driver-flutter-structure]]
owner: claude
audience: both
---

# RCAB-E3.S1 — Flutter app skeleton: routing, theme, Riverpod, dio + refresh

## Goal

Bootstrap the Flutter driver app at `apps/driver-app/` with production-quality scaffolding: go_router wired to all screen routes from [[driver-screens]] (stubbed content only), Riverpod as the DI + state container, a dio HTTP client with a JWT refresh interceptor, build flavors (dev/prod), and the exact folder structure from [[driver-flutter-structure]]. No feature logic in this story — this is the foundation every subsequent E3 story builds on top of.

## User-facing acceptance criteria

- `Given` the app is launched in the `dev` flavor on an Android emulator, `When` it starts cold, `Then` the `/sign-in` stub screen renders without error.
- `Given` the app is on the `/sign-in` stub screen, `When` a developer navigates programmatically to `/home`, `/profile`, `/earnings`, `/offer/test-id`, or `/ride/test-id`, `Then` the corresponding stub screen renders without crashing.
- `Given` the dio client makes an authenticated API call and the server returns `401`, `When` the stored refresh token is valid, `Then` the interceptor transparently calls `POST /v1/auth/refresh`, stores the new JWT, and retries the original request — the caller receives the successful response.
- `Given` the dio client receives `401` and the refresh call also returns `401`, `When` this happens, `Then` the interceptor calls `authProvider.signOut()` (clears stored tokens) and go_router redirects to `/sign-in`.

## Technical acceptance criteria

- `apps/driver-app/` is a Flutter 3.x Android-first project (`--org com.rcab --platforms android`). `pubspec.yaml` declares all packages from [[driver-flutter-structure]] § Key packages: `flutter_riverpod`, `go_router`, `dio`, `socket_io_client`, `firebase_auth`, `firebase_messaging`, `flutter_foreground_task`, `geolocator`, `freezed`, `json_serializable`, `flutter_local_notifications`, `url_launcher`, `flutter_secure_storage`, `permission_handler`.
- Folder layout matches [[driver-flutter-structure]] exactly: `lib/core/{api,auth,realtime,location,fcm,logger}/`, `lib/features/{auth,home,offer,ride,earnings,profile,shared}/`, `lib/routing/app_router.dart`, `lib/di/providers.dart`, `lib/app.dart`, `lib/main.dart`.
- `lib/routing/app_router.dart` — `GoRouter` with six routes: `/sign-in`, `/home`, `/offer/:id`, `/ride/:id`, `/earnings`, `/profile`. Auth guard: any route except `/sign-in` redirects to `/sign-in` when `authProvider` state is `AuthState.unauthenticated`. Initial location: `/sign-in`.
- `lib/core/auth/token_store.dart` — `FlutterSecureStorage`-backed store exposing `Future<void> saveTokens({required String jwt, required String refresh})`, `Future<String?> getJwt()`, `Future<String?> getRefresh()`, `Future<void> clear()`.
- `lib/core/api/api_client.dart` — dio instance with `BaseOptions(baseUrl: apiBaseUrl)` sourced from `--dart-define=API_BASE_URL`; attaches `Authorization: Bearer <jwt>` via `InterceptorsWrapper.onRequest`; on 401 `onError`: calls `POST /v1/auth/refresh` with stored refresh token, if 200 saves new JWT and retries the original request, if 401 calls `ref.read(authProvider.notifier).signOut()`.
- `lib/di/providers.dart` — `authProvider` is a `StateNotifier<AuthState>` (`AuthState` is a sealed class / freezed union: `unauthenticated | authenticated(driver)`) with initial state `unauthenticated`; exposes `signOut()`. `apiClientProvider` returns the configured dio instance. `tokenStoreProvider` returns `TokenStore`.
- Build flavors: `dev` — `--dart-define=API_BASE_URL=http://10.0.2.2:3000` (Android emulator localhost), verbose dio `LogInterceptor` enabled. `prod` — `--dart-define=API_BASE_URL=https://api.rcab.app`, no debug logging, ProGuard rules for `socket_io_client`.
- `lib/app.dart` — `ProviderScope` wrapping `MaterialApp.router(routerConfig: appRouter)`; Material 3 theme with placeholder brand color `Color(0xFF1B8EF8)` (marked `// TODO: brand palette — pending design`).
- `android/app/src/main/AndroidManifest.xml` — `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` permissions declared (service and location logic is added in RCAB-E3.S4, not here).
- `flutter analyze` reports zero errors and zero warnings.

## Test plan

- Widget: `test/routing/app_router_test.dart` — use `GoRouter.navigate` to exercise each route; assert the stub screen's key is present in the widget tree for all 6 routes.
- Unit: `test/core/api/jwt_refresh_interceptor_test.dart` — mock dio `HttpClientAdapter`; assert: (a) on 401 → `POST /v1/auth/refresh` called → original request retried with new JWT; (b) on refresh 401 → `signOut()` called.
- `flutter test` must pass green. `flutter analyze` zero issues.

## Out of scope

- Any real auth logic — that is RCAB-E3.S2.
- Vehicle registration screen or API — that is RCAB-E3.S3.
- Online/offline toggle or foreground service start/stop — that is RCAB-E3.S4.
- FCM / push notification wiring — deferred; not required for Demo 2.
- iOS build target — Phase-1 per [[ADR-0006-flutter-driver-app]].

## Notes / questions

- `apps/driver-app/` is outside the pnpm workspace. Ensure the root `.gitignore` excludes Flutter build artifacts (`apps/driver-app/build/`, `apps/driver-app/.dart_tool/`).
- The placeholder brand color `Color(0xFF1B8EF8)` should survive through Demo 2. A brand-palette ADR is a separate concern — do not create one as part of this story.
- If `flutter create` generates boilerplate counter-app code, delete it before the first commit. The `lib/` directory starts from scratch with the structure above.

## See also

- [[epic-e3-driver-presence]] · [[driver-flutter-structure]] · [[driver-screens]] · [[driver-state-management]]
- [[ADR-0006-flutter-driver-app]] · [[rest-endpoints]] · [[story-rcab-e3-s2-firebase-otp-flutter]] · [[story-rcab-e3-s3-vehicle-registration]]
