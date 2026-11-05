-- F07 / F15 (R05) — account-scoped, fingerprint-bound idempotency.
--
-- Before: rides.idempotency_key was globally UNIQUE and looked up globally, so
-- one account's key could replay (leak) another account's ride, and two users
-- picking the same key collided. Shared create had no idempotency at all.
--
-- After: a key is scoped to (principal, operation, key) and carries a SHA-256
-- fingerprint of the request's business intent (see
-- apps/api/src/modules/rides/idempotency.ts for the canonical form):
--   same scope + same fingerprint      → replay the stored result
--   same scope + different fingerprint → 422 idempotency_key_conflict
--   different principal / operation    → independent request
--
-- Legacy rows: every pre-0013 ride is backfilled to its operation (from
-- `type`) and keeps request_fingerprint NULL. A NULL fingerprint is replayable
-- by its owner only (already owner+operation scoped); it is never matched
-- across accounts. Existing keys were globally unique, so they are trivially
-- unique under the narrower composite scope — no dedup needed.
--
-- Retention: solo/scheduled keys live on the ride row for the ride's lifetime;
-- idempotency_record rows are kept indefinitely in Phase-0 (no purge job yet).
-- There is no Redis TTL in front of either — the durable row is the contract.
--
-- Rollout: single-VPS deploy, migration applied before the new api serves
-- traffic. Old code's ON CONFLICT (idempotency_key) has no matching constraint
-- after this, so do not run the pre-0013 api against this schema.

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS idempotency_operation text NOT NULL DEFAULT 'ride.create.solo',
  ADD COLUMN IF NOT EXISTS request_fingerprint text;

UPDATE rides
   SET idempotency_operation = 'ride.create.scheduled'
 WHERE type = 'scheduled'
   AND idempotency_operation <> 'ride.create.scheduled';

ALTER TABLE rides
  DROP CONSTRAINT IF EXISTS rides_idempotency_operation_check;
ALTER TABLE rides
  ADD CONSTRAINT rides_idempotency_operation_check
  CHECK (idempotency_operation IN ('ride.create.solo', 'ride.create.scheduled'));

-- Add the scoped constraint first, then drop the global one, so there is never
-- a moment with no uniqueness at all.
ALTER TABLE rides
  DROP CONSTRAINT IF EXISTS rides_idempotency_scope_uq;
ALTER TABLE rides
  ADD CONSTRAINT rides_idempotency_scope_uq
  UNIQUE (passenger_id, idempotency_operation, idempotency_key);

ALTER TABLE rides
  DROP CONSTRAINT IF EXISTS rides_idempotency_key_key;

-- Durable idempotency for create operations without a single row of their own
-- (shared create = a seat in a pool). `pending` is claimed BEFORE the side
-- effect so a retry/concurrent duplicate can't allocate a second seat;
-- `completed` holds the replayable response.
CREATE TABLE IF NOT EXISTS idempotency_record (
  principal_id        uuid        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  operation           text        NOT NULL,
  idempotency_key     text        NOT NULL,
  request_fingerprint text        NOT NULL,
  state               text        NOT NULL DEFAULT 'pending'
                                  CONSTRAINT idempotency_record_state_check
                                  CHECK (state IN ('pending', 'completed')),
  resource_id         uuid,
  response            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  PRIMARY KEY (principal_id, operation, idempotency_key)
);
