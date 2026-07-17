---
title: RCAB-E6.S4 — Cancellation of a scheduled ride (before/after wake)
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e6-scheduled-booking]]
demo: 5
estimate: xs
hitl: no
depends_on: [[story-rcab-e6-s3-wake-worker]], [[story-rcab-e4-s8-cancellation-paths]]
affected_notes: [[module-rides]]
owner: claude
audience: both
---

# RCAB-E6.S4 — Cancellation of a scheduled ride (before/after wake)

## Goal

A client can cancel a scheduled ride. Before the wake fires it's a free cancel that also
drops the pending wake job; after wake the ride is a normal in-flight ride and the existing
E4.S8 cancellation rules apply unchanged.

## User-facing acceptance criteria

- `Given` a scheduled ride still `requested` (pre-wake), `When` the client cancels, `Then`
  it becomes `cancelled` (free, Phase-0) and its pending wake job is removed so it never fires.
- `Given` a scheduled ride that already woke and was accepted, `When` a party cancels,
  `Then` the standard E4.S8 rules apply (no special-casing).

## Technical acceptance criteria

- `RidesController.cancel` calls `ScheduledDispatchService.cancelWake(rideId)` on a
  successful cancel of a `type='scheduled'` ride. `cancelWake` is idempotent — a no-op
  after the ride has woken (job gone).
- No new state: `requested` is already client-cancellable (E4.S8), and `dispatchSolo`
  guards `status='requested'`, so even a lost cancel/wake race can't dispatch a cancelled
  ride. The wake-job removal is the only addition.

## Test plan

- Unit (`rides.controller.spec.ts`): a scheduled cancel calls `cancelWake`; a normal cancel
  does not.
- Covered by S1's integration test that `cancelWake` removes a pending job.
- Gate: `pnpm verify` green (unit 300 @ 78.9/88/74.2, int 97).

## Out of scope

- Cancel-fee logic — Phase-0 has none (E4.S8 decision).
- Web/driver cancel UI for scheduled rides — reuses the existing cancel button (Demo 5 walk).

## Epic status

**E6 complete → Demo 5 ("Scheduled works") is walkable:** book a future ride → it wakes
~10 min before pickup → dispatches like a normal ride → completes; cancel freely before
wake (job dropped) or per normal rules after.

## See also
- [[epic-e6-scheduled-booking]] · [[story-rcab-e6-s3-wake-worker]] · [[story-rcab-e4-s8-cancellation-paths]]
