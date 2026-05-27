---
title: Driver app — background location
tags: [layer/client-driver]
status: accepted
phase: 0
depends_on: [[driver-flutter-structure]]
related: [[journey-driver-go-online]], [[sm-driver-availability]]
audience: both
---

# Driver app — background location

*Android foreground service while online. iOS deferred.*

## Why a foreground service

Android aggressively kills regular background work, especially on OEM ROMs (Xiaomi, Realme, Vivo, Oppo — common in our market). A **foreground service** with an ongoing notification is the only path to reliable continuous location.

## Permissions

- `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`.
- Request `BACKGROUND_LOCATION` after the user has experienced the foreground flow once — Google Play requires the rationale.

## Sampling strategy

| Driver state | Cadence | Accuracy hint |
|---|---|---|
| `online` (no ride) | 5 s | balanced |
| `on_ride` (en route / in_progress) | 3 s | high |
| `offline` | service stopped | — |

We **also** debounce: skip sending if movement < 10 m since last sample (still update local UI).

## Implementation (RCAB-E3.S5)

- `LocationTaskHandler` (in `lib/core/location/foreground_service.dart`) handles the 5 s tick: calls `Geolocator.getCurrentPosition(medium)`, measures `Geolocator.distanceBetween()` against `lastEmitted`, skips if < 10 m, otherwise calls `sendPort?.send({lat, lng, heading, speed})`.
- `LocationBridge` (in `lib/core/realtime/location_bridge.dart`) listens on `FlutterForegroundTask.receivePort` in the main isolate and forwards each location map to `socket.emit('driver:location', ...)`.
- Server-side 3 s throttle in `RealtimeGateway.handleDriverLocation` deduplicates bursts.
- `locationStreamProvider` (`StreamProvider<Position>`) wraps `Geolocator.getPositionStream()` for future UI map dot (not the WS path).

## Battery budget

Target: < 6% per hour at peak (on_ride). We hit this by:

- Duty-cycling the accuracy hint.
- Wake locks only when the WS or HTTP is actively sending.
- Disabling sensor fusion features we don't need.

## OEM kill mitigation

- Display an onboarding step: "Add rcab to battery whitelist." Link to OS-specific settings via `permission_handler`.
- Show a banner in the app if the service has been killed within 24 h.

## See also
- [[driver-flutter-structure]] · [[journey-driver-go-online]]
- [[sm-driver-availability]] · [[entity-location]]
