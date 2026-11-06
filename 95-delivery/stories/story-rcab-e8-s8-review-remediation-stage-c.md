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
affected_notes: [[module-rides]], [[schema-postgres]]
owner: claude
audience: both
---

# RCAB-E8.S8 — Review remediation Stage C

## Goal

Make the business guarantees durable (review findings F05, F06, F08, F09; guide R06–R08). Branch `remediation/stage-c`, stacked on `remediation/stage-a-b`. Design contract: `docs/remediation/stage-c-contract.md`. Migrations `0014_dispatch_offer_assignment.sql`, `0015_outbox.sql`, `0016_pool_membership.sql`. Status stays `in_progress` until the HITL sign-off below.

## Acceptance criteria

- F05 — Given an offer accept, Then the trip is derived from the stored `dispatch_offer` row (client `sharedRideId` ignored) and ownership, expiry (DB clock), generation, trip state and eligibility are checked in one transaction; forged / foreign / expired / declined / stale offers are rejected. *Test:* `dispatch-offer-assignment.int.spec.ts`, `dispatch-offer-gateway.int.spec.ts`.
- F06 — Given one driver racing for two trips (solo or shared), Then at most one active assignment exists (`driver_active_assignment` guard shared by both trip types), and completing trip X never clears trip Y. *Test:* `dispatch-offer-assignment.int.spec.ts` (multi-pool races, I1–I4 invariants).
- F08 — Given a booking commit, Then its dispatch/wake intent is written to the outbox in the same transaction and a relay + reconciler drive it to completion; BullMQ jobs complete only after the dispatch work ran. *Test:* `outbox-dispatch.int.spec.ts`, `outbox-e2e.int.spec.ts`.
- F09 (+F15 duplicate membership) — Given concurrent joins/closure, Then `pool_member`, seat count, pool state and itinerary change in one transaction; Redis `pool:<id>` is a versioned projection rebuilt from Postgres. *Test:* `pool-membership.int.spec.ts`, `pool-lifecycle.int.spec.ts`.

## Not in scope / follow-ups

- F10 shared realtime/accept protocol (R09, Stage D).
- Scheduled accept/escalation window: feature note says 4 min, code 60 s — unchanged, owner decision.
- Outbox metrics, retention purge; expiring very old never-dispatched rides (reconciler re-arms).
- Shared fare policy (F15 fare half, R10).

## HITL sign-off

- Owner review of PR + migration rehearsal on a copy of real data before any deploy.
