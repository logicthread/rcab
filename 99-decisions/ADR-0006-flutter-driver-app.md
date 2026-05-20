---
title: ADR-0006 — Driver app in Flutter
tags: [layer/decision, kind/adr]
status: accepted
phase: 0
related: [[driver-flutter-structure]], [[driver-background-location]], [[tech-stack]]
audience: both
---

# ADR-0006 — Driver app in Flutter

*The driver app is built in Flutter, Android-first.*

- **Status:** accepted
- **Date:** 2026-05-19
- **Phase:** 0

## Context

The driver app must be native — Android with reliable background location, FCM data messages, foreground services, and OEM-aware battery handling. iOS is deferred.

## Decision

Use **Flutter 3.x** for the driver app. Android-only build target in Phase-0. iOS target left intact in the codebase for Phase-1.

## Consequences

- Positive
  - Single codebase, single team for Android now and iOS later.
  - Excellent plugin ecosystem for the things we need: `firebase_messaging`, `geolocator`, `flutter_foreground_task`, `permission_handler`, `flutter_local_notifications`.
  - Riverpod + freezed gives us testable, type-safe state.
- Negative
  - Background services on Android still require platform code (Kotlin) for OEM-specific behaviors.
  - Flutter team needs to learn Android Doze, foreground service lifecycle.
- Neutral
  - APK size larger than a native Kotlin app (mitigated to ≤ 30 MB budget — see [[performance-budget]]).

## Alternatives considered

- **Native Kotlin** — best ecosystem fit for background work; doubles the team for iOS later.
- **React Native** — viable but background services are weaker; the team has Flutter experience.

## See also
- [[driver-flutter-structure]] · [[driver-background-location]] · [[driver-push-notifications]]
- [[tech-stack]] · [[performance-budget]]
