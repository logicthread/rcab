---
title: RCAB-E5.S3 — Pool lifecycle (open → grow → close → start)
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e5-shared-booking]]
demo: 4
estimate: m
hitl: no
depends_on: [[story-rcab-e5-s2-matching-service-slot-vs-open]], [[sm-shared-ride-pool]], [[entity-shared-ride]], [[redis-usage]]
blocks: [[story-rcab-e5-s4-shared-ride-dispatch]]
affected_notes: [[sm-shared-ride-pool]], [[entity-shared-ride]], [[redis-usage]]
owner: claude
audience: both
---

# RCAB-E5.S3 — Pool lifecycle (open → grow → close → start)

## Goal

A shared-ride pool moves through discrete states from the moment it opens until a driver is assigned. This story implements the full state machine from [[sm-shared-ride-pool]] in NestJS, including the BullMQ delayed-job expiry timer, and wires the matching service output into the booking endpoint as the first end-to-end shared-booking path. After this story a `POST /v1/rides` with `type=shared` creates a pool, slots requests, and closes the pool after 60 s or when max-seats is reached.

## User-facing acceptance criteria

- `Given` a client submits `type=shared` at `POST /v1/rides`, `When` no open pool exists, `Then` a new pool opens, a 60-second expiry timer starts, and the response includes `{ sharedRideId, mode: 'opened', poolStatus: 'open' }`.
- `Given` a pool is open and a second compatible request arrives, `When` it is slotted, `Then` the response includes `{ mode: 'slotted', sharedRideId: <same id> }`.
- `Given` a pool has `seat_count = max_seats`, `When` the last slot is filled, `Then` the pool immediately transitions to `closed_full` and no further slots are accepted.
- `Given` a pool is open and 60 seconds elapse without filling, `When` the BullMQ `pool:expire` job fires, `Then` the pool transitions to `closed_timeout` and dispatch is triggered.
- `Given` a pool has already closed (any closed_* state), `When` a new compatible request arrives, `Then` it opens a new pool rather than slotting into the closed one.

## Technical acceptance criteria

- `apps/api/src/modules/matching/pool-lifecycle.service.ts`:
  - `openPool(request): Promise<SharedRide>` — creates DB record, enqueues `pool:expire:<pool_id>` BullMQ job with `delay: 60_000`.
  - `slotRequest(pool, request): Promise<void>` — increments `seat_count`; if `seat_count === max_seats` calls `closePool(pool, 'closed_full')`.
  - `closePool(pool, reason: 'closed_full' | 'closed_timeout' | 'aborted'): Promise<void>` — updates DB state, removes expiry job if `reason !== 'closed_timeout'`, emits `pool:closed` internal event consumed by dispatch.
- BullMQ queue `matching` processes `pool:expire` jobs in `PoolExpireProcessor`.
- `POST /v1/rides` with `type=shared` delegates to `MatchingService.findOrCreatePool()` then `PoolLifecycleService.openPool()` or `slotRequest()`.
- Pool state stored in both Postgres (`shared_rides.state`) and Redis HASH `pool:<pool_id>` (for low-latency reads in dispatch).
- Redis HASH keys: `state`, `seat_count`, `max_seats`, `closed_at`.

## Test plan

- **Unit (Vitest):** `pool-lifecycle.service.spec.ts` — mock BullMQ queue, DB repository; assert `pool:expire` job enqueued with correct delay; assert `closePool('closed_full')` removes the expiry job; assert `closePool('closed_timeout')` does not attempt removal; assert state written to Redis HASH.
- **Integration (Testcontainers Postgres + Redis + BullMQ):** POST two shared rides; verify pool opens then auto-closes after a simulated expiry; verify DB `state = 'closed_timeout'`; verify Redis HASH updated.
- **E2E (Playwright):** not required for this story — demo walk via curl is sufficient.

## Out of scope

- Dispatch fan-out when pool closes — that is E5.S4.
- Client notification of pool status updates — that is E5.S6.
- `aborted` transition (no driver found after close) — governed by E5.S4 failure path.

## Notes / questions

- `pool:expire` jobs must survive API restarts: BullMQ stores them in Redis. BullMQ is already used in E6 (scheduled bookings) so the queue infra will be wired there; this story may need to pre-wire the BullMQ module if E6 hasn't landed yet.
- "Remove the expiry job" uses `BullMQ Job.remove()` by job ID `pool:expire:<pool_id>`. Store job ID in Redis HASH at `expiry_job_id` key.

## See also

- [[epic-e5-shared-booking]] · [[sm-shared-ride-pool]] · [[entity-shared-ride]]
- [[redis-usage]] · [[module-matching]]
- [[story-rcab-e5-s2-matching-service-slot-vs-open]] · [[story-rcab-e5-s4-shared-ride-dispatch]]
