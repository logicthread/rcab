---
title: Entity — Vehicle
tags: [layer/domain, kind/entity]
status: accepted
phase: 0
depends_on: [[entity-driver]]
related: [[entity-ride]]
audience: both
---

# Vehicle

*A car / bike / auto operated by a driver.*

## Fields

| Field | Type | Notes |
|---|---|---|
| id | uuid (v7) | pk |
| driver_id | uuid | fk → driver.user_id |
| type | enum('auto', 'bike', 'cab_hatch', 'cab_sedan') | |
| reg_no | text | unique within country |
| make | text | |
| model | text | |
| color | text | |
| seats | int | excluding driver |
| active | bool | default true |
| created_at | timestamptz | |

## Notes

- A driver can own multiple vehicles but operates one at a time (`driver.current_vehicle_id`).
- Vehicle `type` affects which ride types it can serve. A `bike` cannot serve a shared ride (Phase-0 rule).

## See also
- [[entity-driver]] · [[entity-ride]]
