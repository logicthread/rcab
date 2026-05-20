---
title: Entity — Notification
tags: [layer/domain, kind/entity]
status: accepted
phase: 0
depends_on: [[entity-user]]
related: [[module-realtime]], [[integration-fcm]]
audience: both
---

# Notification

*A delivered message to a user (push / in-app / SMS-future).*

## Fields

| Field | Type | Notes |
|---|---|---|
| id | uuid (v7) | pk |
| user_id | uuid | fk |
| kind | enum | `ride_offer`, `ride_matched`, `ride_started`, `ride_completed`, `rating_received`, `system` |
| channel | enum | `push`, `websocket`, `inapp` |
| payload | jsonb | structured data |
| sent_at | timestamptz | nullable until delivery confirmed |
| read_at | timestamptz | nullable |
| created_at | timestamptz | |

## Notes

- Persisted **only for kinds that matter post-hoc** (e.g., `rating_received`, `ride_completed`). Transient operational events like `location_update` are not persisted.
- This table also doubles as the in-app notification feed for the driver dashboard.

## See also
- [[module-realtime]] · [[integration-fcm]]
- [[entity-user]]
