---
title: RCAB-E8.S16 — Booking hold, 3 matching rounds, next-ride queue, booking UX fixes
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S16
demo: 7
estimate: l
hitl: yes
depends_on: [[story-rcab-e8-s8-review-remediation-stage-c]], [[story-rcab-e8-s10-central-policy-config]]
blocks:
affected_notes: [[algo-top-k-dispatch]], [[features-top-k-dispatch]], [[module-dispatch]], [[schema-postgres]], [[websocket-events]], [[sm-driver-availability]], [[journey-client-book-normal]], [[policy-config]]
owner: claude
audience: both
---

# RCAB-E8.S16 — Booking hold, 3 matching rounds, next-ride queue, booking UX fixes

## Goal

Owner feedback 2026-11-18 after a manual walk: make booking and dispatch behave the way riders and drivers expect. Eight changes, one story.

## User-facing acceptance criteria

- Given a scheduled ("Later") ride was just booked, When the rider looks at the form, Then the same pickup/drop are still there with a confirmation, and an immediate ride can be booked.
- Given an immediate booking, When the rider taps Book, Then no driver is contacted for 5 s and Cancel inside that window is free.
- Given a reload, a finished ride or a scheduled booking, Then pickup and drop (with address labels) are back; only sign-out clears them.
- Given the ride-type toggle, Then Share is disabled ("coming soon") and Private is the default.
- Given the booking form, Then Book is disabled until pickup and drop are both set.
- Given an offer on the driver app, Then it shows fare, distance and time only (distance/time from the driver's current position to the pickup).
- Given a driver on an in-progress ride within 10 min (road ETA) of its drop-off, Then they may be offered, and accept, one next ride, which starts when the current one ends.
- Given a booking nobody accepts, Then matching restarts from wave 1 up to 3 rounds before `no_driver`.

## Technical acceptance criteria

- Policy `dispatch.bookingHoldMs` (5 s), `dispatch.rounds` (3), `dispatch.busyDriverEtaMs` (10 min); web `booking.bookingHoldMs`; `docs/POLICY.md` regenerated.
- Outbox intent of a normal ride written with `available_at = now + hold`; `OutboxRelay.kick(afterMs)`.
- `rearmNormalRide` (generation = round); `handleHardFail` re-arms below `rounds`.
- Migration `0020_driver_queued_assignment.sql`; accept path queues when the guard says `driver_busy` and the OSRM ETA qualifies; `transition`/`cancel` promote/dequeue in the same transaction; a queued ride cannot be advanced.
- `DriverEtaService`; offer payload `pickupDistanceM`, `pickupDurationS`, `nextRide`; accepted/outcome carry `queued`.

## Test plan

- Unit: dispatch rounds (re-arm vs last round), policy defaults, web store/book-client/toggle, Flutter offer screen.
- Integration: `dispatch-next-ride.int.spec.ts` (queue, promote on completion, refuse when far, cancel while queued, rounds); existing suites run with hold 0 and 1 round.
- Live check on the dev stack: first offer 5.147 s after the booking.

## HITL stops

- Acceptance criteria changed mid-flight (next-ride queue is new capability); owner requested it explicitly. Migration 0020 applied to the dev DB.

## Out of scope

- Shared rides stay switched off in the UI (page logic kept); no next-ride queue for shared trips.
- A scheduled ride is not restored by a reload (no list of scheduled rides yet).
- Not yet walked by hand on real accounts (needs the owner).

## Notes / questions

- Searching can now take about 3 min before `no_driver` (3 rounds x 60 s).
- Driver-app distance/time uses OSRM `/table`, falling back to a straight-line estimate.
