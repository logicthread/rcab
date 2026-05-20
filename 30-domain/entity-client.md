---
title: Entity — Client
tags: [layer/domain, kind/entity]
status: accepted
phase: 0
depends_on: [[entity-user]]
related: [[entity-ride-request]], [[features-history-dashboard]]
audience: both
---

# Client

*Profile attached to a [[entity-user]] with `role=client`.*

## Fields

| Field | Type | Notes |
|---|---|---|
| user_id | uuid | pk, fk → user.id, unique |
| home_label | text | nullable — "Home" saved address |
| home_point | geography(Point,4326) | nullable |
| work_label | text | nullable |
| work_point | geography(Point,4326) | nullable |
| rating_avg | numeric(3,2) | nullable; weighted mean — see [[algo-rating-aggregation]] |
| rating_count | int | default 0 |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## Notes

- We deliberately store only **two saved places** (home, work) for Phase-0 — most cab apps overload this; we keep it minimal.
- Recent destinations are derived on read from [[entity-ride-request]] history.

## See also
- [[entity-user]] · [[entity-ride-request]]
- [[features-history-dashboard]]
