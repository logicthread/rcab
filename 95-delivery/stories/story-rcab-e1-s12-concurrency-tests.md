---
title: RCAB-E1.S12 — Concurrency test suite for race-prone paths
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: s
hitl: no
depends_on: [[story-template]], [[story-rcab-e1-s11-int-teardown-fix]]
affected_notes: [[testing-strategy]]
owner: claude
audience: both
---

# RCAB-E1.S12 — Concurrency test suite for race-prone paths

## Goal

The critique flagged that the stateful Redis/Postgres machinery (dispatch claim, pool
seat allocation, idempotency) is race-prone but barely tested — only **1** concurrency
test existed (`claimSolo`). Add integration tests that assert the correctness invariants
under genuine contention, so a regression in the atomicity guards is caught. These also
de-risk E6, which extends the same BullMQ/dispatch surface.

## User-facing acceptance criteria

- `Given` two requests with the same idempotency key genuinely in flight, `When` both
  `RidesRepository.create`, `Then` exactly one row exists and both resolve to it.
- `Given` more joiners than free seats racing a pool, `When` they `slotRequest`
  concurrently, `Then` exactly `maxSeats − seatCount` are granted and the pool never
  over-seats (Redis counter ≤ maxSeats).
- `Given` a client and the bound driver cancel an `accepted` ride at once, `When` both
  `cancel()`, `Then` exactly one applies and the loser gets `invalid_transition`.

## Technical acceptance criteria

- Tests added: `rides-idempotency.int.spec.ts` (concurrent double-submit; concurrent
  cancel race) and `dispatch-pool.int.spec.ts` (concurrent slotRequest over-seating).
- Use `Promise.all([...])` for real contention; assert atomic-guard invariants.
- **Mutation-verified:** removing `SELECT … FOR UPDATE` from `cancel()` makes the
  cancel-race test fail (and only it) → the test genuinely guards the isolation.
- Stable across 3+ consecutive `pnpm test:int` runs (91/91).

## Test plan

- Unit: n/a (integration-only concurrency).
- Integration: the 3 tests above, real Postgres + Redis via Testcontainers.
- Mutation check documented in the story/PR.

## Out of scope

- **Wave-2-during-pending-claim** and **pool-close-during-join** races — timing-dependent;
  deferred to avoid flaky tests (candidate follow-up with deterministic clock control).
- **transition() race** — the mutation check showed no test covers a concurrent
  `transition()` (removing its FOR UPDATE broke nothing); a transition-race test is a
  follow-up.
- Seed-data uniqueness (`Math.random` phone/reg_no collisions, the ~1/18 flake) — folded
  into the verify-gate story (RCAB-E1.S13/A4).

## Notes / questions

- Harness finding: `dispatch-pool.int.spec.ts` wraps a **single** `pg.Client`, so two
  `db.transaction()` calls multiplex one connection and `FOR UPDATE` can't isolate them —
  transaction-isolation tests must use a real `pg.Pool` (as `rides-idempotency.int.spec.ts`
  does). Documented so future concurrency tests pick the right harness.
- Potential smell (not a failing test): `PoolLifecycleService.slotRequest` writes the
  DB `seat_count` via `incrementSeats(result)` (last-write-wins) while the Redis counter
  is the atomic source — worth a look if DB seat_count is ever read authoritatively.

## See also
- [[epic-e1-foundation]] · [[testing-strategy]] · [[story-rcab-e1-s11-int-teardown-fix]]
