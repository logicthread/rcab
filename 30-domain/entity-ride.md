---
title: Entity — Ride
tags: [layer/domain, kind/entity]
status: accepted
phase: 0
depends_on: [[data-model]]
related: [[entity-ride-request]], [[entity-shared-ride]], [[entity-driver]], [[entity-vehicle]], [[sm-ride-lifecycle]]
audience: both
---

# Ride

*A trip that a driver is actually performing.*

A `Ride` represents the **driver-side** record. For solo bookings, one `RideRequest` ↔ one `Ride`. For shared bookings, one `Ride` holds multiple `RideRequest`s, and the `Ride` row is supplemented by a [[entity-shared-ride]] row.

## Fields

| Field | Type | Notes |
|---|---|---|
| id | uuid (v7) | pk |
| driver_id | uuid | fk |
| vehicle_id | uuid | fk |
| type | enum('solo', 'shared') | |
| state | enum | see [[sm-ride-lifecycle]] |
| origin_summary | jsonb | for displaying without joining |
| dest_summary | jsonb | |
| route_polyline | text | OSRM-encoded, set after matching, may update on shared expansion |
| est_distance_m | int | |
| est_duration_s | int | |
| actual_distance_m | int | nullable; from driver location stream sum |
| actual_duration_s | int | nullable |
| total_fare | numeric(10,2) | nullable until completed |
| platform_commission | numeric(10,2) | nullable |
| driver_payout | numeric(10,2) | nullable |
| started_at | timestamptz | nullable |
| completed_at | timestamptz | nullable |
| canceled_at | timestamptz | nullable |
| cancel_reason | text | nullable |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## Invariants

- `type=shared` requires a matching row in `shared_ride`.
- `total_fare` set only when `state ∈ {completed}`.
- `state` transitions are constrained — only the values in [[sm-ride-lifecycle]] are allowed and only via the state machine code.

## See also
- [[entity-ride-request]] · [[entity-shared-ride]]
- [[sm-ride-lifecycle]] · [[module-rides]]
