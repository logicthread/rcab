---
title: Driver app — push notifications
tags: [layer/client-driver]
status: accepted
phase: 0
depends_on: [[driver-flutter-structure]]
related: [[integration-fcm]], [[journey-driver-accept-ride]]
audience: both
---

# Driver app — push notifications

*FCM as the safety net behind WebSocket.*

## FCM message types

| Kind | Notification | Data | When |
|---|---|---|---|
| `ride_offer` | Silent (data-only) | `{ offer_id, ttl_ms, request_summary }` | every new offer |
| `ride_revoked` | Silent | `{ offer_id, reason }` | offer expired |
| `ride_state_changed` | Silent | `{ ride_id, state }` | mid-ride updates if WS dropped |
| `system_alert` | Visible | `{ title, body }` | ops broadcast |

## Why data-only for offers

We render our own full-screen ringing UI on `ride_offer` (more attention-grabbing than a system notification). The default notification is suppressed so we don't get a double-buzz.

To make data-only delivery reliable when the app is killed: **set `priority: high` and `apns_priority: 10` (later)**; Android delivers high-priority data messages even in Doze.

## Registration

- App fetches an FCM token on first login.
- Token POSTed to `/v1/drivers/me/fcm-token`. Stored on the driver row; replaced on rotation.
- Token deleted on logout.

## Local notification fallback

If FCM data arrives while the app is fully killed, the FCM background handler shows a **local notification** via `flutter_local_notifications` so the driver actually hears it. Tapping the notification opens the offer screen.

## See also
- [[integration-fcm]] · [[journey-driver-accept-ride]]
- [[driver-background-location]]
