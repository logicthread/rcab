---
title: RCAB-E6.S3 — Wake-up worker reuses the normal dispatch path
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e6-scheduled-booking]]
demo: 5
estimate: s
hitl: no
depends_on: [[story-rcab-e6-s2-scheduled-request]], [[module-dispatch]]
affected_notes: [[module-dispatch]]
owner: claude
audience: both
---

# RCAB-E6.S3 — Wake-up worker reuses the normal dispatch path

## Goal

When a scheduled ride's wake job fires, dispatch it exactly like a normal booking — no
new dispatch logic. The processor emits the same `ride.requested` event a normal ride
fires at creation; `DispatchService` already handles it → `dispatchSolo`.

## User-facing acceptance criteria

- `Given` a scheduled ride in `requested` and a nearby online driver, `When` its wake job
  fires, `Then` the driver receives a `ride_offer` (the ride enters the normal dispatch
  waves).
- `Given` a scheduled ride cancelled before wake, `When` the wake somehow fires, `Then`
  nothing dispatches (`dispatchSolo` guards on `status='requested'`).

## Technical acceptance criteria

- `ScheduledDispatchProcessor.process` emits `RIDE_REQUESTED_EVENT { rideId }` (injects
  `EventEmitter2`). **No `ScheduledModule → DispatchModule` import** — that would close a
  cycle (RidesModule → ScheduledModule → DispatchModule → RidesModule). `EventEmitter2` is
  global; the event constant is a value-only import. drift-check green.
- `dispatchSolo` already skips a not-found / non-`requested` ride, so the cancelled-before-
  wake race is safe with zero extra code.

## Test plan

- Unit (`scheduled.processor.spec.ts`): emits `ride.requested` on a wake job; ignores an
  unexpected job name.
- Integration (`dispatch-pool.int.spec.ts`): end-to-end — a scheduled ride + online driver,
  run the real processor → `ride.requested` → `dispatchSolo` → driver gets `ride_offer`.
- Gate: `pnpm verify` green (unit 298 @ 78.8/88/74.2, int 97).

## Also in this story (test-reliability, folded in)

- **Fixed the pre-existing seed-collision flake** (the E1.S12 follow-up). `Math.random()`
  phone/reg_no generators (9000-wide) collided ~10%/run against global UNIQUE constraints
  (it flaked "duplicate reg_no → 409" during this story's verify). Added
  `@rcab/test-fixtures` `uniquePhone()` / `uniqueRegNo()` (randomUUID-seeded, ~1e-7
  collision) and swapped all int-spec generators. 5×5 clean `test:int` runs after.

## Out of scope

- Cancellation of a scheduled ride (before/after wake) — **E6.S4**.
- Retry/escalation if no driver accepts — the existing hard-fail path already applies.

## See also
- [[epic-e6-scheduled-booking]] · [[story-rcab-e6-s2-scheduled-request]] · [[module-dispatch]]
