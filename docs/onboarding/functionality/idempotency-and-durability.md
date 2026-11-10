# Idempotency and durability

Two mechanisms make "the user tapped Book and the network flaked" and "the process died right after the commit" safe: **idempotent creates** (a retry returns the original result) and the **transactional outbox plus reconciler** (committed intent always becomes work). Both are Postgres-first; Redis is rebuilt, never trusted.

Back to [README](../README.md) · see also [dispatch-and-offers](dispatch-and-offers.md), [shared-rides](shared-rides.md), [scheduled-rides](scheduled-rides.md), [`docs/operations/recovery-runbook.md`](../../operations/recovery-runbook.md), [`docs/remediation/stage-c-contract.md`](../../remediation/stage-c-contract.md) (sections 1.3 and 3 are normative).

## Part 1 · Idempotent create

### Contract

- Header `Idempotency-Key`: 1 to 128 visible ASCII characters (`[\x21-\x7e]{1,128}`). Required for `type=normal` and `type=scheduled`; optional (but used by the web) for `type=shared`. Missing: 400 `idempotency_key_required`; malformed: 400 `idempotency_key_invalid`.
- A key is only meaningful inside its **scope** `(account, operation, key)`. Operations: `ride.create.solo`, `ride.create.scheduled`, `ride.create.shared`. The same string from another account, or for another operation, is an unrelated request, so a key is never a bearer credential.
- Each stored request keeps a **fingerprint**: SHA-256 of `{ operation, origin (6 dp), dest (6 dp), scheduledFor (epoch ms, scheduled only) }`. The quote token is deliberately **not** part of it, so the web can re-quote after a lost response and retry under the same key.
- Same key + same fingerprint: the original result is replayed (solo/scheduled: the caller's own ride row; shared: the stored response). Same key + different fingerprint: 422 `idempotency_key_conflict` and nothing mutates. A replay is resolved **before** the quote token and the scheduled window are validated, so a late retry always recovers the committed booking.
- Shared creates in flight: 409 `idempotency_request_in_progress` (the claim is `pending`). The web replays once after 1 s (`booking.idempotencyInProgressRetryMs`).

### Storage

| Operation | Where the key lives |
|---|---|
| solo / scheduled | on the ride: `rides.idempotency_key`, `idempotency_operation`, `request_fingerprint`, unique `(passenger_id, idempotency_operation, idempotency_key)` (migration 0013); a legacy row has a NULL fingerprint and replays for its owner |
| shared | `idempotency_record (principal_id, operation, idempotency_key, request_fingerprint, state pending\|completed, resource_id, response)`, primary key = the scope; plus `pool_member.idempotency_key` linking the key to the seat |

There is no purge job and no TTL: records live as long as the ride/seat. Phase-0 volume makes that acceptable.

### Shared flow (`RidesController.createShared`)

1. `claim` the scope as `pending` **before** any side effect. Existing claim: fingerprint mismatch -> 422; `completed` with a response -> replay; else 409 in progress. A `pending` claim older than `IDEMPOTENCY_PENDING_RECLAIM_MS` (60 s) is **reclaimed** by a same-fingerprint retry.
2. A reclaim first looks for a seat already committed under that key (`pool_member.idempotency_key`) and answers with it; otherwise allocation proceeds.
3. The seat and the claim completion are **one transaction** (`PoolLifecycleService`), so a committed seat always has its replayable response.
4. If allocation throws, the claim is released so the client's retry can proceed.

### Web client

`lib/booking/intent.ts`: one key per booking intent (ride type + route), reused on every retry, rotated on a changed intent or after confirmed success. Error handling in `book-client.tsx` maps `quote_expired` (clear key, re-quote), `idempotency_key_conflict` (rotate, re-quote), `idempotency_key_invalid` (rotate), `idempotency_request_in_progress` (keep key).

## Part 2 · Transactional outbox

### Why

A booking commit must guarantee that dispatch will eventually start, even if the process dies one millisecond later, and must never start dispatch for a booking that rolled back. So the work intent is a row in the **same transaction** as the business change; a separate relay turns committed rows into BullMQ jobs.

### The table

`outbox` (migration 0015): `topic`, `aggregate_type` (`ride`|`shared_ride`), `aggregate_id`, `aggregate_generation`, `payload`, unique `dedupe_key = <topic>:<aggregateId>:g<generation>`, `available_at`, `attempts`, `max_attempts` (10), `lease_token`/`leased_until`, `processed_at`, `failed_at`, `last_error`. `processed_at` means **published**, not business-complete.

| Topic | Written by | Becomes |
|---|---|---|
| `ride.dispatch.requested` | solo create; scheduled re-arm | BullMQ `dispatch:start` (job `dispatch-start-<id>-g<g>`) |
| `ride.wake.schedule` | scheduled create | delayed `scheduled:wake` on `scheduled-dispatch` (job `scheduled-wake-<id>-g<g>`) |
| `pool.dispatch.requested` | pool close (full or timeout) | `dispatch:start` with `kind: pool` |
| `pool.expire.schedule` | pool open | delayed `pool:expire` on `matching` (job `pool-expire-<poolId>`) |

Writer: `enqueueOutbox(tx, message)` (idempotent on the dedupe key). Callers nudge the relay with `relay.kick()` after commit but never publish.

### Relay (`OutboxRelay`, in the API process)

Poll every `OUTBOX_RELAY_POLL_MS` (1 s) and on every `kick()`. One drain at a time per process: **lease** up to `OUTBOX_RELAY_BATCH` (50) due rows in one `UPDATE ... FOR UPDATE SKIP LOCKED` (30 s lease, `attempts` += 1), publish each to BullMQ, then **ack** with the lease token (a lost lease is a no-op). Failure: exponential backoff `2^attempts` s capped at 300 s; after `max_attempts` or a permanent error (unknown topic, bad payload) the row is marked `failed_at` (**exhausted**). A published-but-unacked row is re-published after the lease expires; deterministic job ids make that a no-op. BullMQ itself retries each job `OUTBOX_JOB_ATTEMPTS` (5) times with `OUTBOX_JOB_BACKOFF_MS` exponential backoff. `RCAB_DISABLE_OUTBOX_RELAY=1` disables the relay and sampler (tests).

### Reconciler (`DispatchReconciler`)

At boot and every `OUTBOX_RECONCILE_INTERVAL_MS` (5 min), skipping trips touched in the last `OUTBOX_RECONCILE_GRACE_MS` (15 s), up to 500 per pass. Independent steps (a failure in one does not block the others): un-woken scheduled rides with no wake job; in-flight solo dispatch missing its start job or timers (and scheduled rides whose window lapsed: retry or end); open pools missing their expiry job; closed unclaimed pools missing dispatch. It trusts Postgres, not outbox `processed_at`: a processed row only proves a job once existed, and Redis may have been flushed. Repairs re-arm the outbox row (or restore the timer) and are logged as `reconcile repaired missing durable work`. Final step publishes backlog stats.

### Observability

Gauges `rcab_outbox_pending`, `rcab_outbox_oldest_pending_age_seconds`, `rcab_outbox_exhausted` (sampled every 15 s, removed when unreadable); counter `rcab_outbox_publish_total{result}` (`published|retry|exhausted|lost_lease`); counter `rcab_dispatch_outcome_total{outcome="infra_failure"}` when a dispatch job fails for good. The Grafana **Dispatch** dashboard has Outbox backlog, oldest due row age and publish results (video M01). Alert-worthy: exhausted > 0, oldest pending > 60 s.

### Operator moves

- Inspect: `SELECT topic, count(*) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL) pending, count(*) FILTER (WHERE failed_at IS NOT NULL) exhausted FROM outbox GROUP BY 1;` and the invariant SQL in the stage-c contract (section 6).
- Re-arm an exhausted row: the next reconciler pass does it, or set `failed_at = NULL, attempts = 0, available_at = now()` for that row.
- Redis lost: restart the api (or wait for the next reconcile); drill in `scripts/recovery/redis-loss-drill.sh`, documented in the recovery runbook.
- A driver with two active trips found by migration 0014 is recorded in `migration_conflict`; resolve with `scripts/recovery/resolve-driver-conflict.sql`.

## Policy knobs

[Idempotency](../../POLICY.md#idempotency): `IDEMPOTENCY_PENDING_RECLAIM_MS`. [Outbox relay and reconciler](../../POLICY.md#outbox-relay--reconciler): `OUTBOX_RELAY_POLL_MS`, `OUTBOX_RELAY_BATCH`, `OUTBOX_RELAY_LEASE_MS`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_JOB_ATTEMPTS`, `OUTBOX_JOB_BACKOFF_MS`, `OUTBOX_RECONCILE_INTERVAL_MS`, `OUTBOX_RECONCILE_GRACE_MS`, `OUTBOX_RECONCILE_MAX_PER_PASS`. Web: `booking.idempotencyInProgressRetryMs`.

## Code entry points

`modules/rides/{idempotency,idempotency.repository,rides.controller,rides.repository}.ts`; `modules/matching/pool-lifecycle.service.ts`; `modules/outbox/{outbox.types,outbox.writer,outbox.repository,outbox.relay,outbox.jobs,dispatch-reconciler.service}.ts`; `db/constraints.ts` (constraint-name to typed error mapping); `apps/web/src/lib/booking/intent.ts`.

## Tests

Unit: `rides.idempotency.spec.ts`, `outbox.relay.spec.ts`, `outbox.jobs.spec.ts`, `outbox.types.spec.ts`, `dispatch-reconciler.service.spec.ts`, `constraints.spec.ts`. Integration: `rides-idempotency.int.spec.ts`, `outbox-dispatch.int.spec.ts`, `outbox-e2e.int.spec.ts`, `pool-lifecycle.int.spec.ts`, `migrations-stage-c.int.spec.ts`. Web: `intent.test.ts`, `book-client.test.tsx`.

## Known gaps

- No retention policy for `outbox` (processed rows accumulate), `idempotency_record`, or `dispatch_offer`.
- Exhausted outbox rows alert only through gauges; there is no Alertmanager rule for them yet (alert rules cover only API 5xx rate and p99 latency; E8.S2).
- ~~Outbox and reconciler warnings were invisible because Nest `Logger` output was discarded.~~ Fixed in 74a1b38 (see [admin-and-observability](admin-and-observability.md)): "reconcile repaired" and "outbox backlog" lines now reach Loki; the gauges remain the primary signal.
- The reconciler cannot recover a booking whose commit never happened (by design) or a Postgres loss (restore from backup).
