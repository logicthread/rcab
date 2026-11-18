---
title: RCAB-E8.S17 — Booking: vehicle picker, shared rides behind a flag, pool view fix
tags: [layer/delivery, kind/story]
status: in_review
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S17
demo: 7
estimate: m
hitl: yes
depends_on: [[story-rcab-e8-s16-web-design-system-themes]], [[features-normal-booking]], [[features-shared-rides]]
blocks:
affected_notes: [[features-normal-booking]], [[features-shared-rides]], [[web-state-management]], [[web-pages-routes]]
owner: claude
audience: both
---

# RCAB-E8.S17 — Booking: vehicle picker, shared rides behind a flag, pool view fix

## Goal

Owner decisions 2026-11-18: hide Share for now (it returns later), let riders pick a vehicle at booking, and fix the booking form still showing after a shared ride starts.

## User-facing acceptance criteria

- Given the booking screen, When it loads, Then there is no Share/Private toggle and every booking is private.
- Given the booking screen, When it loads, Then a "Choose a vehicle" row offers Bike, Auto (3 seats), Cab, SUV and 6 seater, with Cab selected.
- Given a shared ride exists (flag on), When the pool is open, closed or "Trip under way", Then the page shows the map and pool status, never the booking form.

## Technical acceptance criteria

- `config/features.ts` `FEATURES.sharedRides = false`; the shared code, tests and store paths stay; flipping the flag restores them. `test-setup.ts` turns it on so the shared suites keep running.
- `VehicleType` / `VEHICLE_OPTIONS` in `lib/booking/types.ts`, `vehicle` in the booking store, `vehicle-picker.tsx`.
- **The vehicle choice is UI-only**: the API prices and dispatches by route only, and its vehicle types are `auto`, `bike`, `cab_hatch`, `cab_sedan`.

## Test plan

- Unit: flag off hides the toggle and books private; picker lists five options, defaults to Cab, stores the choice; pool view replaces the form after open and after `closed_started`.

## HITL stops

- Fares per vehicle, SUV / 6-seater driver types and dispatch filtering are product decisions (not built; see Out of scope).

## Out of scope

- Per-vehicle fares, vehicle-filtered dispatch, new vehicle types in the schema, driver-app vehicle registration for them. Needs the owner's fare table and a mapping of `cab_hatch` / `cab_sedan` to Cab / SUV, then an impact analysis.
- Re-enabling Share.

## See also
- [[epic-e8-production-hardening]] · [[features-normal-booking]] · [[features-shared-rides]]
- [[story-rcab-e8-s16-web-design-system-themes]] · [[story-rcab-e8-s21-snap-pickup-dropoff-to-road]]
