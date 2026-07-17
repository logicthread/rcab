---
title: RCAB-E6.S2 — type=scheduled flow at quote + request (+ migration)
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e6-scheduled-booking]]
demo: 5
estimate: m
hitl: yes
depends_on: [[story-rcab-e6-s1-bullmq-runner]], [[features-scheduled-booking]], [[entity-ride-request]]
affected_notes: [[entity-ride-request]], [[features-scheduled-booking]]
owner: claude
audience: both
---

# RCAB-E6.S2 — type=scheduled flow at quote + request (+ migration)

## Goal

Let a client place a scheduled booking: quote it (priced like a normal ride), then request
it with a future `scheduled_for`. A scheduled request persists `type='scheduled'` and
enqueues a BullMQ wake job (E6.S1) ~10 min before pickup **instead of** dispatching now.

## User-facing acceptance criteria

- `Given` a scheduled quote, `When` I POST `/v1/rides/quote` with `type=scheduled`, `Then`
  I get a normal fare quote + signed token (no longer `NotImplemented`).
- `Given` a signed quote, `When` I POST `/v1/rides` with `type=scheduled` +
  `scheduledFor` in the 15 min–24 h window, `Then` a `requested` ride is stored with
  `type=scheduled` + `scheduled_for`, a wake job is enqueued, and dispatch does NOT fire now.
- `Given` `scheduledFor` missing or out of window, `Then` 400
  (`scheduled_for_required` / `scheduled_for_out_of_window`).
- `Given` a replayed idempotency key, `Then` no second wake is scheduled.

## Technical acceptance criteria

- **Migration 0011_rides_scheduled.sql** (HITL-approved, additive): `rides.type` text NOT
  NULL DEFAULT 'normal' + CHECK ('normal','shared','scheduled'), `rides.scheduled_for`
  timestamptz null. Applied to dev DB; Drizzle schema updated; RideRow/toRow/create carry
  the fields.
- `RidesController.createScheduled` mirrors `createNormal` (idempotent, quote-locked) but
  validates the window and calls `ScheduledDispatchService.scheduleWake` instead of
  emitting `RIDE_REQUESTED_EVENT`. `quote` no longer throws for scheduled.
- `RidesModule` imports `ScheduledModule` (code graph edge added; drift-check green).

## Test plan

- Unit (`rides.controller.spec.ts`): scheduled quote priced; scheduled create persists
  type+scheduled_for + schedules wake + no dispatch; replay no-reschedule; 400 for
  missing / <15 min / >24 h.
- Integration (`rides-idempotency.int.spec.ts`): repo persists type=scheduled +
  scheduled_for (migration 0011 applied by Testcontainers).
- Gate: `pnpm verify` green (unit 296 @ 78.6/88/73.7 cov, int 96).

## HITL stops

- **Migration on the shipped `rides` table — approved this session** (additive, default
  'normal' preserves existing rows).

## Out of scope

- Wake handler running dispatch (`dispatchSolo`) — **E6.S3**.
- Cancellation of a scheduled ride — **E6.S4**.
- Web/driver UI for scheduling — later (Demo 5 walk).

## See also
- [[epic-e6-scheduled-booking]] · [[story-rcab-e6-s1-bullmq-runner]] · [[features-scheduled-booking]] · [[entity-ride-request]]
