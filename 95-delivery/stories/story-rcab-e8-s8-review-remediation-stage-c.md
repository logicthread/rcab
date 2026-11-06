---
title: RCAB-E8.S8 — Review remediation Stage C (offer auth, driver exclusivity, durable dispatch, pool transactions)
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S8
demo: 7
estimate: xl
hitl: yes
depends_on: [[story-rcab-e8-s7-review-remediation-stage-ab]]
blocks:
affected_notes: [[module-rides]], [[schema-postgres]], [[module-dispatch]], [[module-matching]], [[redis-usage]], [[module-realtime]]
owner: claude
audience: both
---

# RCAB-E8.S8 — Review remediation Stage C

## Goal

Make the business guarantees durable (review findings F05, F06, F08, F09; guide R06–R08). Branch `remediation/stage-c`, stacked on `remediation/stage-a-b`. Design contract: `docs/remediation/stage-c-contract.md`. Migrations `0014_dispatch_offer_assignment.sql`, `0015_outbox.sql`, `0016_pool_membership.sql`, `0017` (`pool_member.agreed_fare_cents`). Stage D slice R09 (realtime) and the scheduled-window / fare stand-in follow-ups are included here. Status stays `in_progress` until the HITL sign-off below.

## Acceptance criteria

- F05 — Given an offer accept, Then the trip is derived from the stored `dispatch_offer` row (client `sharedRideId` ignored) and ownership, expiry (DB clock), generation, trip state and eligibility are checked in one transaction; forged / foreign / expired / declined / stale offers are rejected. *Test:* `dispatch-offer-assignment.int.spec.ts`, `dispatch-offer-gateway.int.spec.ts`.
- F06 — Given one driver racing for two trips (solo or shared), Then at most one active assignment exists (`driver_active_assignment` guard shared by both trip types), and completing trip X never clears trip Y. *Test:* `dispatch-offer-assignment.int.spec.ts` (multi-pool races, I1–I4 invariants).
- F08 — Given a booking commit, Then its dispatch/wake intent is written to the outbox in the same transaction and a relay + reconciler drive it to completion; BullMQ jobs complete only after the dispatch work ran. *Test:* `outbox-dispatch.int.spec.ts`, `outbox-e2e.int.spec.ts`.
- F09 (+F15 duplicate membership) — Given concurrent joins/closure, Then `pool_member`, seat count, pool state and itinerary change in one transaction; Redis `pool:<id>` is a versioned projection rebuilt from Postgres. *Test:* `pool-membership.int.spec.ts`, `pool-lifecycle.int.spec.ts`.
- F10 (R09) — Given a client or driver subscribing to a pool or ride, Then access is authorized against Postgres and a Postgres snapshot is returned (`pool:snapshot`, `ride:snapshot`, `driver:assignment`, `driver:sync`); incremental events are versioned (pool = `shared_rides.state_version`, ride = status rank) and offer results arrive as `ride_offer_outcome` (assigned/lost/expired/revoked/rejected) plus a `ride_offer_response` ack. *Test:* `realtime-snapshot.int.spec.ts`.
- Scheduled window — Given a scheduled ride wakes, Then drivers have a 4-minute accept window (`SCHEDULED_DISPATCH_WINDOW_MS=240000`, wave one `SCHEDULED_DISPATCH_WAVE_ONE_MS` default half); and Given nobody accepts, Then the ride is re-armed with a new generation (no cap) and the passenger is told once (`ride_dispatch_retry`). *Test:* `scheduled-window.spec.ts`, `scheduled-retry.int.spec.ts`.
- Fare stand-in — Given a shared join, Then the seat fare is quoted inside the join transaction from the itinerary (`quoteSeatInItinerary`, `PRICING_OSRM_TIMEOUT_MS`), stored in `pool_member.agreed_fare_cents` (migration 0017: required, immutable) and never readjusted (`SHARED_FARE_POLICY='fixed_at_join'`). *Test:* pricing specs and `pool-membership.int.spec.ts`.

## Owner decisions

- Scheduled accept window: **4 minutes** (flag F-1 resolved; see `docs/remediation/stage-c-contract.md`).
- Unanswered scheduled rides are retried **without a cap**; the passenger is told once.
- Shared fare is **fixed at join** until the real pooled-pricing story RCAB-E8.S9 (draft).

## Not in scope / follow-ups

- Outbox metrics, retention purge; expiring very old never-dispatched rides (reconciler re-arms).
- Real shared fare policy / re-pricing (F15 fare half, R10) — RCAB-E8.S9.
- Member cancellation / no-show in pools, pool fallback to solo, early driver assignment for scheduled trips (still open owner decisions).

## HITL sign-off

- Owner review of PR + migration rehearsal on a copy of real data before any deploy.
