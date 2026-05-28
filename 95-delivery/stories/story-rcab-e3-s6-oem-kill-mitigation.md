---
title: RCAB-E3.S6 — OEM-kill mitigation onboarding
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e3-driver-presence]]
demo: 2
estimate: xs
hitl: no
depends_on: [[story-rcab-e3-s4-driver-online-toggle]], [[driver-background-location]]
affected_notes: [[driver-background-location]]
owner: claude
audience: both
---

# RCAB-E3.S6 — OEM-kill mitigation onboarding

## Goal

On OEM Android ROMs (Xiaomi, Realme, Vivo, Oppo — common in the target market), the OS aggressively kills foreground services unless the app is battery-whitelisted. This Flutter-only story implements two countermeasures from [[driver-background-location]] § OEM kill mitigation: (1) a one-time onboarding sheet that guides the driver to the OS battery whitelist settings immediately after their first online toggle, and (2) a persistent banner on `/home` if the foreground service was detected killed within the last 24 hours. No API changes.

## User-facing acceptance criteria

- `Given` I toggle online for the first time ever, `When` the foreground service starts, `Then` a bottom sheet appears explaining why battery whitelist access is needed, with an "Open Settings" button and a "Skip" button.
- `Given` I tap "Open Settings", `When` the OS settings page for battery optimisation opens, `Then` I can whitelist rcab from there; on returning to the app the sheet is dismissed.
- `Given` I have already seen the onboarding sheet, `When` I go online again later, `Then` the sheet does not appear a second time.
- `Given` the foreground service was killed by the OS within the last 24 hours (detected on app resume), `When` the `/home` screen is shown, `Then` a yellow banner reads "Your location service was stopped — please whitelist rcab in battery settings" with a link to settings.
- `Given` the foreground service has been running without interruption for more than 24 hours, `When` I open `/home`, `Then` no banner is shown.

## Technical acceptance criteria

- `lib/features/home/oem_onboarding_sheet.dart` — `showModalBottomSheet` triggered after a successful `goOnline()` call if `SharedPreferences.getBool('oem_onboarding_shown') != true`. Contains explanatory copy, "Open Settings" button (calls `openBatteryOptimizationSettings()` from `permission_handler` or `url_launcher` with Android intent `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), and "Skip" button. On dismiss (either button): `SharedPreferences.setBool('oem_onboarding_shown', true)`.
- `lib/features/home/service_kill_banner.dart` — `MaterialBanner` widget shown on `/home` if `SharedPreferences.getInt('last_service_kill_at')` exists and `now - last_service_kill_at < 86400000 ms` (24 h). "Open Settings" action on the banner calls the same OS settings intent.
- `lib/core/location/foreground_service.dart` — in the `FlutterForegroundTask` `onDestroy` callback (called when the OS kills the service), record `SharedPreferences.setInt('last_service_kill_at', DateTime.now().millisecondsSinceEpoch)`.
- Service health check on app resume: `WidgetsBindingObserver.didChangeAppLifecycleState` in `HomeScreen` — on `AppLifecycleState.resumed`, calls `FlutterForegroundTask.isRunningService` and if false (and driver state is online) records `last_service_kill_at` as above and rebuilds the banner.
- No new network calls, no new API endpoints, no new Riverpod providers beyond what S4 already adds.

## Test plan

- Widget: `test/features/home/oem_onboarding_sheet_test.dart` — mock `SharedPreferences`; assert sheet appears when `oem_onboarding_shown=false`; assert sheet does not appear when `oem_onboarding_shown=true`; assert preference is set to `true` after "Skip" tap.
- Widget: `test/features/home/service_kill_banner_test.dart` — mock `SharedPreferences` with a `last_service_kill_at` < 24 h ago; assert banner is visible; mock with > 24 h ago; assert banner is absent.
- `flutter test` must pass green.

## Out of scope

- Automatic restart of the foreground service after OS kill — Phase-0 shows the guidance banner and relies on the driver to act; auto-restart requires deeper `WorkManager` integration (Phase-1 candidate).
- iOS battery/background handling — iOS deferred per [[ADR-0006-flutter-driver-app]].
- Any API-side tracking of service kill events.

## Notes / questions

- `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` requires the `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission in `AndroidManifest.xml` — this was declared in S1's manifest (see RCAB-E3.S1 Technical AC). If it was skipped, add it here.
- The `onDestroy` callback in `FlutterForegroundTask` may not always fire when the OS force-kills a process (OEM ROM behavior varies). The app-resume health check via `FlutterForegroundTask.isRunningService` is the more reliable path and should be the primary detection mechanism.
- OEM-specific deep-links to battery settings (Xiaomi's `MIUI Power Saver`, Oppo's `App Quick Freeze`, etc.) are complex to maintain. For Phase-0 use the standard Android `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent only; device-specific intents are a Phase-1 improvement.

## See also

- [[epic-e3-driver-presence]] · [[driver-background-location]] · [[ADR-0006-flutter-driver-app]]
- [[story-rcab-e3-s4-driver-online-toggle]] · [[story-rcab-e3-s5-location-streaming]]
