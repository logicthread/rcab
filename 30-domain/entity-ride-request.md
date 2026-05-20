---
title: Entity — RideRequest
tags: [layer/domain, kind/entity]
status: accepted
phase: 0
depends_on: [[data-model]]
related: [[entity-ride]], [[entity-client]], [[sm-booking-flow]], [[features-shared-rides]], [[features-normal-booking]], [[features-scheduled-booking]]
audience: both
---

# RideRequest

*What the client placed. Becomes part of a [[entity-ride]] when matched.*

## Fields

| Field | Type | Notes |
|---|---|---|
| id | uuid (v7) | pk |
| client_id | uuid | fk → client.user_id |
| type | enum('normal', 'shared', 'scheduled') | |
| state | enum | see [[sm-booking-flow]] |
| origin_point | geography(Point,4326) | |
| origin_label | text | reverse-geocoded for display |
| dest_point | geography(Point,4326) | |
| dest_label | text | |
| scheduled_for | timestamptz | nullable, set when type=scheduled |
| fare_estimate | numeric(10,2) | from quote |
| ride_id | uuid | nullable; set when matched |
| pool_seat_index | int | nullable; ordinal within a shared ride |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## Invariants

- A `RideRequest` exists from the moment the client confirms a quote. Even when canceled, the row is kept for history.
- `ride_id` is set exactly once and is monotonic.
- A `shared` request that times out without a co-rider may fall back to `solo` — the existing `RideRequest` retains `type=shared` but the linked `Ride` is `type=solo`. (We chose this over flipping the request's type so audit history is exact.)

## See also
- [[entity-ride]] · [[entity-shared-ride]] · [[entity-client]]
- [[sm-booking-flow]] · [[features-shared-rides]]
