---
title: Integration — FCM (push)
tags: [layer/integration, kind/integration]
status: accepted
phase: 0
depends_on: [[tech-stack]]
related: [[driver-push-notifications]], [[module-realtime]]
audience: both
---

# FCM (Firebase Cloud Messaging)

*Push delivery to driver Android devices.*

## API

- HTTP v1 (`https://fcm.googleapis.com/v1/projects/<id>/messages:send`).
- Service account JSON kept in [[secrets-management]].
- A small typed client in `infra/fcm/` wraps it.

## Message shape

```json
{
  "message": {
    "token": "<device_token>",
    "android": { "priority": "high", "ttl": "12s" },
    "data": {
      "kind": "ride_offer",
      "offer_id": "...",
      "payload_b64": "..."
    }
  }
}
```

- `data`-only (no `notification` field) so the app fully controls UI.
- `ttl=12s` matches the offer TTL — there's no point delivering a stale offer.
- `priority=high` so Android wakes the device out of Doze.

## Token lifecycle

- App POSTs the FCM token on login and on rotation (`onTokenRefresh`).
- Stored on `driver` as `fcm_token` (or in a dedicated `device_token` table if we go multi-device later).
- Deleted on logout.

## See also
- [[driver-push-notifications]] · [[module-realtime]] · [[journey-driver-accept-ride]]
