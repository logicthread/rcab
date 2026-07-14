---
title: RCAB-E1.S11 — Fix flaky integration teardown (make `pnpm test:int` honest)
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: s
hitl: no
depends_on: [[story-template]], [[testing-strategy]]
affected_notes: [[testing-strategy]]
owner: claude
audience: both
---

# RCAB-E1.S11 — Fix flaky integration teardown (make `pnpm test:int` honest)

## Goal

`pnpm test:int` reported **2 files FAILED despite 88/88 tests passing** — ~6 unhandled
`Connection is closed.` ioredis rejections during `app.close()`, exit 1. "Green" was
untrustworthy, undermining the whole demo-cadence guarantee (verification debt, top
critique risk). Root-cause and fix so a green integration run means green.

## User-facing acceptance criteria

- `Given` a healthy Docker + the integration suite, `When` I run `pnpm test:int`, `Then`
  it exits 0 with 17/17 files and 88/88 tests, **zero** `Connection is closed.` output —
  repeatably (verified 21 consecutive runs).
- `Given` a future real unhandled rejection, `When` it fires during a run, `Then` the run
  **fails** (no blanket `dangerouslyIgnoreUnhandledErrors` masking it).

## Technical acceptance criteria

- Root cause (corrected — prior "BullMQ shared connection" call was never confirmed and
  was wrong): (1) socket.io **Redis adapter** subscriber client leaks a pending `SUBSCRIBE`
  that rejects on `.quit()`; (2) **double-quit** — `drivers`/`realtime-location` override
  the `REDIS` provider with their own client, so `app.close()` quits it via
  `RedisModule.onApplicationShutdown` and the spec's `afterAll` quit it a second time.
- `RCAB_DISABLE_WS_ADAPTER=1` in `test/setup.unhandled.ts`; `RealtimeGateway.afterInit`
  skips adapter wiring under it (multi-node pub/sub has no value in single-process tests).
- Redundant `redis.quit()` removed from the two specs' `afterAll` (app owns the close).
- `dangerouslyIgnoreUnhandledErrors` removed from `vitest.config.int.ts`.

## Test plan

- Verification: 21× `pnpm test:int` — all green, `grep -c 'Connection is closed'` = 0, exit 0.
- Negative: with the ignore flag gone, a deliberately-thrown teardown rejection fails the run.

## Out of scope

- The ~1/18 residual flake (cc=0) — a **separate** unproven root cause, likely
  `Math.random()` `phone_e164`/`reg_no` collisions vs unique constraints in seed helpers.
  Fold a seed-uniqueness fix into the concurrency-test story (RCAB-E1.S12).
- Making the socket.io adapter's *production* shutdown reject-free (harmless at process exit).

## Notes / questions

- Nice systematic-debugging case: the documented root cause was a misdiagnosis; isolation
  (disable adapter → 6→1 rejections; then find the double-quit) found the real one.

## See also
- [[epic-e1-foundation]] · [[testing-strategy]] · [[story-rcab-e1-s10-code-graph]]
