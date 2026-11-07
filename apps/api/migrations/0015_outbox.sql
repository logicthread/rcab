-- F08 (R07) — transactional outbox for work that must survive a crash.
--
-- Before: a booking commit, the in-memory `ride.requested` event, the BullMQ
-- wake enqueue and the pool-expiry enqueue were independent steps. A failure
-- between the commit and the enqueue (or a process death) left a persisted
-- booking with no dispatch / wake job, and an idempotent retry replayed the row
-- without ever re-creating the work.
--
-- After: the business mutation and an `outbox` row commit in ONE transaction.
-- A relay inside the api process leases due rows (FOR UPDATE SKIP LOCKED, short
-- transaction), publishes a deterministic BullMQ job, and acknowledges with the
-- lease token (fencing: an expired relay cannot ack a newer attempt). Consumers
-- re-read Postgres state + dispatch_generation and are idempotent; publication
-- is not business completion. No new service — Phase-0 single VPS.
--
-- Columns:
--   topic                 dotted name, e.g. 'ride.dispatch.requested',
--                         'ride.wake.schedule', 'pool.dispatch.requested',
--                         'pool.expire.schedule' (TS constants are the registry)
--   aggregate_type/_id    the business row the work is about
--   aggregate_generation  rides/shared_rides.dispatch_generation the work targets
--   dedupe_key            UNIQUE; `<topic>:<aggregate_id>:g<generation>` — a
--                         retried/duplicated writer cannot enqueue twice
--   available_at          not published before this instant (retry backoff)
--   attempts/max_attempts publish attempts; exhausted → failed_at set
--   lease_token/leased_until  relay lease + fencing token
--   processed_at          published (acknowledged) — NOT business completion
--   failed_at             exhausted / terminal publish failure (operator retry)
--
-- Reconciliation after Redis loss re-arms rows (processed_at = NULL) from the
-- authoritative trip tables; a published row is not proof the job still exists.
--
-- Backfill: every scheduled ride still `requested` and not yet woken gets a
-- 'ride.wake.schedule' row so a wake lost before this migration (F08 repro) is
-- re-published. Re-publishing an existing BullMQ job id is a no-op.

CREATE TABLE IF NOT EXISTS outbox (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  topic                text        NOT NULL,
  aggregate_type       text        NOT NULL,
  aggregate_id         uuid        NOT NULL,
  aggregate_generation int         NOT NULL DEFAULT 0,
  payload              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  payload_version      smallint    NOT NULL DEFAULT 1,
  dedupe_key           text        NOT NULL,
  available_at         timestamptz NOT NULL DEFAULT now(),
  attempts             int         NOT NULL DEFAULT 0,
  max_attempts         int         NOT NULL DEFAULT 10,
  last_error           text,
  lease_token          uuid,
  leased_until         timestamptz,
  processed_at         timestamptz,
  failed_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_dedupe_key_uq UNIQUE (dedupe_key),
  CONSTRAINT outbox_topic_format_check CHECK (topic ~ '^[a-z]+(\.[a-z_]+)+$'),
  CONSTRAINT outbox_aggregate_type_check CHECK (aggregate_type IN ('ride', 'shared_ride')),
  CONSTRAINT outbox_generation_check CHECK (aggregate_generation >= 0),
  CONSTRAINT outbox_attempts_check CHECK (attempts >= 0 AND max_attempts >= 1),
  CONSTRAINT outbox_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_terminal_check CHECK (NOT (processed_at IS NOT NULL AND failed_at IS NOT NULL)),
  CONSTRAINT outbox_lease_pair_check CHECK ((lease_token IS NULL) = (leased_until IS NULL))
);

-- Relay scan: due, unpublished, not exhausted.
CREATE INDEX IF NOT EXISTS outbox_due_idx
  ON outbox (available_at)
  WHERE processed_at IS NULL AND failed_at IS NULL;

-- Reconciler / diagnostics by business row.
CREATE INDEX IF NOT EXISTS outbox_aggregate_idx
  ON outbox (aggregate_type, aggregate_id, topic);

-- Backfill: re-arm wakes for not-yet-woken scheduled rides (generation 0 → the
-- wake targets generation 1, matching what the Stage-C booking path writes).
INSERT INTO outbox
  (topic, aggregate_type, aggregate_id, aggregate_generation, payload, dedupe_key)
SELECT 'ride.wake.schedule',
       'ride',
       r.id,
       1,
       jsonb_build_object('scheduledFor', to_jsonb(r.scheduled_for)),
       'ride.wake.schedule:' || r.id || ':g1'
  FROM rides r
 WHERE r.type = 'scheduled'
   AND r.status = 'requested'
   AND r.dispatch_generation = 0
   AND r.scheduled_for IS NOT NULL
ON CONFLICT ON CONSTRAINT outbox_dedupe_key_uq DO NOTHING;
