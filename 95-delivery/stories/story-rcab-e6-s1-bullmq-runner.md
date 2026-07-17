---
title: RCAB-E6.S1 — BullMQ runner + Redis config for scheduled booking
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e6-scheduled-booking]]
demo: 5
estimate: s
hitl: no
depends_on: [[features-scheduled-booking]], [[redis-usage]]
affected_notes: [[module-map]], [[redis-usage]]
owner: claude
audience: both
---

# RCAB-E6.S1 — BullMQ runner + Redis config for scheduled booking

## Goal

Stand up the delayed-job runner that E6 needs: a BullMQ queue on Redis holding one
wake job per scheduled ride, an enqueue/cancel surface, and a worker skeleton. The wake
job fires ~10 min before `scheduled_for`; the handler that runs dispatch is wired in
E6.S3, and the request-time enqueue in E6.S2. This story is the plumbing.

## User-facing acceptance criteria

- `Given` a scheduled ride, `When` a wake is scheduled, `Then` a delayed job persists on
  the `scheduled-dispatch` queue (`bull:scheduled-dispatch:*`) firing `SCHEDULED_WAKE_LEAD_MS`
  (10 min) before `scheduled_for`.
- `Given` a pending wake, `When` it is cancelled, `Then` the job is removed (free cancel
  before wake — the S4 mechanism).
- `Given` a ride re-scheduled, `Then` only one wake job exists for it (fixed jobId).

## Technical acceptance criteria

- New `modules/scheduled/`: `ScheduledDispatchService` (`scheduleWake`, `cancelWake`),
  `ScheduledDispatchProcessor` (`@Processor(SCHEDULED_DISPATCH_QUEUE)`, autorun-gated per
  E1.S11, `SCHEDULED_DISPATCH_CONCURRENCY` env), `ScheduledModule` (registers the queue,
  exports the service). Registered in `app.module.ts`.
- Delay clamps to 0 when the wake time is already past; jobId = `scheduled:wake:<rideId>`.
- Wake lead overridable via `SCHEDULED_WAKE_LEAD_MS` config.
- `module-map.md` updated (12th module) — `pnpm code:graph:check` green; graph regenerated.

## Test plan

- Unit (`scheduled.service.spec.ts`): delay math, clamp, config override, jobId, cancel
  true/false — mocked queue, fake timers.
- Integration (`scheduled-dispatch.int.spec.ts`): real Redis + BullMQ — job persists with
  correct delay, re-schedule replaces, cancel removes.
- Gate: `pnpm verify` green (lint + coverage floor + int); scheduled module 89.9% covered.

## Out of scope

- Enqueue at quote/request + the `type`/`scheduled_for` columns — **E6.S2** (migration).
- Wake handler running dispatch (`dispatchSolo`) — **E6.S3** (this module imports
  DispatchModule then).
- Cancellation UX / rules — **E6.S4**.

## See also
- [[epic-e6-scheduled-booking]] · [[features-scheduled-booking]] · [[redis-usage]] · [[module-map]]
