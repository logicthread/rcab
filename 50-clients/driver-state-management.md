---
title: Driver app — state management
tags: [layer/client-driver]
status: accepted
phase: 0
depends_on: [[driver-flutter-structure]]
related: [[driver-background-location]]
audience: both
---

# Driver app — state management

*Riverpod providers; streams from the background services hook into the UI.*

## Provider taxonomy

| Provider | Type | Responsibility |
|---|---|---|
| `authProvider` | `StateNotifier<AuthState>` | tokens, Firebase OTP exchange, sign-out, session restore |
| `socketProvider` | `Provider<SocketClient>` | lazy WS connection, auto-reconnect |
| `locationStreamProvider` | `StreamProvider<Position>` | from the foreground location service |
| `driverStateProvider` | `StateNotifier<DriverState>` | offline / online / on_ride |
| `incomingOfferProvider` | `StreamProvider<RideOffer?>` | derived from socket events |
| `activeRideProvider` | `StreamProvider<RideState>` | server-truth ride state |
| `sharedRideProvider` | `StateNotifierProvider<SharedRideNotifier, SharedRideState>` | RCAB-E5.S7 — ordered stops + currentStopIndex; consumes `ride_offer`/`stop:*_confirmed` echoes via `SharedRideController`; hydrates from `GET /v1/rides/:id/stops` on WS reconnect |
| `realtimeSocketProvider` | `Provider<IRealtimeSocket>` | RCAB-E5.S7 — standalone Socket.IO connection used by shared-ride features. Phase-0 carve-out: coexists with `DriverStateNotifier._socket`; consolidation deferred |
| `earningsProvider` | `FutureProvider<EarningsSummary>` | dashboard data, cached |

## Survives backgrounding

The location stream and socket live in a foreground service. If the OS reclaims the Flutter UI, the service keeps publishing events to a `MethodChannel`/`EventChannel`. When the UI rehydrates, providers re-subscribe and replay the latest snapshot.

## See also
- [[driver-flutter-structure]] · [[driver-background-location]]
