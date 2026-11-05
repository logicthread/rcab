-- F05 / F06 (R06) — authoritative dispatch offers + one durable driver
-- assignment guard shared by solo rides and shared rides.
--
-- Before: an offer existed only in Redis (`offer:<id>` 12 s, `offer:meta:<id>` /
-- `offer:type:<id>` 600 s). Accept trusted a client-supplied sharedRideId or the
-- long-lived meta key, so an expired / wrong-driver / forged offer could claim a
-- trip. Claims serialized per ride, never per driver, so one driver could hold a
-- solo ride and a shared ride (or two of either) at once.
--
-- After:
--   * `dispatch_offer` is the authoritative offer: driver, trip, dispatch
--     generation, expiry and state. Accept derives the trip from this row and
--     validates it INSIDE the assignment transaction (DB clock, row locks).
--   * `driver_active_assignment` (PK driver_id) is the single exclusivity guard
--     across both trip tables: at most one active trip per driver, and at most
--     one driver per trip (UNIQUE solo_ride_id / shared_ride_id). It is created
--     in the claim transaction and deleted in the same transaction that moves the
--     trip to a terminal state (completed / cancelled / no_show / aborted).
--   * `dispatch_generation` on both trip tables: every offer and every dispatch
--     job carries it; work for an older generation is stale and must no-op.
--   * `migration_conflict` records rows a migration could not apply mechanically
--     (shared with 0016) — repair is explicit and operator-visible, never a
--     silent timestamp-guess.
--
-- Backfill: in-flight Redis offers are NOT migrated (12 s lifetime); a driver
-- accepting a pre-deploy offer gets `offer_not_found` and the ride's dispatch
-- continues / hard-fails as normal. Active trips are copied into the guard.
-- A driver with more than one active trip, or an active trip whose driver row
-- does not exist, gets NO guard row; each such trip is recorded in
-- migration_conflict for an operator to resolve (no ride is cancelled here).
--
-- Rollout: single-VPS deploy; applied before the Stage-C api serves traffic.
-- Purely additive — the pre-Stage-C api ignores the new tables and columns.

-- ── Conflict inventory (shared by 0014 / 0016) ─────────────────────────────

CREATE TABLE IF NOT EXISTS migration_conflict (
  id          bigserial   PRIMARY KEY,
  migration   text        NOT NULL,
  kind        text        NOT NULL,
  subject     jsonb       NOT NULL,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution  text,
  CONSTRAINT migration_conflict_once_uq UNIQUE (migration, kind, subject)
);

CREATE INDEX IF NOT EXISTS migration_conflict_open_idx
  ON migration_conflict (migration, kind)
  WHERE resolved_at IS NULL;

-- ── Dispatch generation on both trip tables ────────────────────────────────

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS dispatch_generation int NOT NULL DEFAULT 0;
ALTER TABLE rides
  DROP CONSTRAINT IF EXISTS rides_dispatch_generation_check;
ALTER TABLE rides
  ADD CONSTRAINT rides_dispatch_generation_check CHECK (dispatch_generation >= 0);

ALTER TABLE shared_rides
  ADD COLUMN IF NOT EXISTS dispatch_generation int NOT NULL DEFAULT 0;
ALTER TABLE shared_rides
  DROP CONSTRAINT IF EXISTS shared_rides_dispatch_generation_check;
ALTER TABLE shared_rides
  ADD CONSTRAINT shared_rides_dispatch_generation_check CHECK (dispatch_generation >= 0);

-- Every trip that has already been dispatched (or never needs a wake) is on
-- generation 1. Only a not-yet-woken scheduled ride and an open pool stay on 0.
UPDATE rides
   SET dispatch_generation = 1
 WHERE dispatch_generation = 0
   AND NOT (type = 'scheduled' AND status = 'requested');

UPDATE shared_rides
   SET dispatch_generation = 1
 WHERE dispatch_generation = 0
   AND pool_state <> 'open';

-- ── Authoritative offers ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dispatch_offer (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_kind           text        NOT NULL,
  ride_id             uuid        REFERENCES rides(id) ON DELETE CASCADE,
  shared_ride_id      uuid        REFERENCES shared_rides(ride_id) ON DELETE CASCADE,
  driver_id           uuid        NOT NULL REFERENCES driver(user_id) ON DELETE CASCADE,
  dispatch_generation int         NOT NULL,
  wave_number         smallint    NOT NULL DEFAULT 1,
  state               text        NOT NULL DEFAULT 'offered',
  offered_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  resolved_at         timestamptz,
  CONSTRAINT dispatch_offer_trip_kind_check
    CHECK (trip_kind IN ('solo', 'shared')),
  CONSTRAINT dispatch_offer_one_trip_check
    CHECK (num_nonnulls(ride_id, shared_ride_id) = 1),
  CONSTRAINT dispatch_offer_trip_matches_kind_check
    CHECK ((trip_kind = 'solo') = (ride_id IS NOT NULL)),
  CONSTRAINT dispatch_offer_state_check
    CHECK (state IN ('offered', 'accepted', 'declined', 'expired', 'revoked')),
  CONSTRAINT dispatch_offer_generation_check CHECK (dispatch_generation >= 1),
  CONSTRAINT dispatch_offer_wave_check CHECK (wave_number >= 1),
  CONSTRAINT dispatch_offer_expiry_check CHECK (expires_at > offered_at),
  CONSTRAINT dispatch_offer_resolved_check
    CHECK ((state = 'offered') = (resolved_at IS NULL)),
  -- A driver is offered a given trip generation at most once (replaces the
  -- Redis `ride:<id>:offered` / `pool:<id>:offered` sets as the authority).
  CONSTRAINT dispatch_offer_solo_driver_uq UNIQUE (ride_id, dispatch_generation, driver_id),
  CONSTRAINT dispatch_offer_shared_driver_uq UNIQUE (shared_ride_id, dispatch_generation, driver_id)
);

-- One live offer per driver: reserves the DRIVER, not a random offer id (F06).
-- The writer expires the driver's lapsed offers (state='offered' AND
-- expires_at <= now()) in the same transaction before inserting a new one.
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_offer_one_live_per_driver_uq
  ON dispatch_offer (driver_id)
  WHERE state = 'offered';

-- At most one accepted offer per trip generation.
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_offer_solo_one_accept_uq
  ON dispatch_offer (ride_id, dispatch_generation)
  WHERE state = 'accepted' AND ride_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_offer_shared_one_accept_uq
  ON dispatch_offer (shared_ride_id, dispatch_generation)
  WHERE state = 'accepted' AND shared_ride_id IS NOT NULL;

-- Sweeper / revoke-on-claim lookups.
CREATE INDEX IF NOT EXISTS dispatch_offer_live_expiry_idx
  ON dispatch_offer (expires_at)
  WHERE state = 'offered';

-- ── Driver exclusivity guard (both trip types) ─────────────────────────────

CREATE TABLE IF NOT EXISTS driver_active_assignment (
  driver_id           uuid        PRIMARY KEY REFERENCES driver(user_id) ON DELETE CASCADE,
  solo_ride_id        uuid        UNIQUE REFERENCES rides(id) ON DELETE CASCADE,
  shared_ride_id      uuid        UNIQUE REFERENCES shared_rides(ride_id) ON DELETE CASCADE,
  offer_id            uuid        UNIQUE REFERENCES dispatch_offer(id) ON DELETE SET NULL,
  dispatch_generation int         NOT NULL,
  assigned_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_active_assignment_one_trip_check
    CHECK (num_nonnulls(solo_ride_id, shared_ride_id) = 1),
  CONSTRAINT driver_active_assignment_generation_check CHECK (dispatch_generation >= 1)
);

-- ── Backfill the guard from currently-active trips ─────────────────────────

CREATE TEMP TABLE _active_trip ON COMMIT DROP AS
  SELECT r.driver_id,
         'solo'::text             AS trip_kind,
         r.id                     AS trip_id,
         r.dispatch_generation    AS generation,
         COALESCE(r.accepted_at, r.updated_at) AS assigned_at
    FROM rides r
   WHERE r.driver_id IS NOT NULL
     AND r.status IN ('accepted', 'en_route', 'arrived', 'in_progress')
  UNION ALL
  SELECT s.claimed_by_driver_id,
         'shared'::text,
         s.ride_id,
         s.dispatch_generation,
         COALESCE(s.claimed_at, s.updated_at)
    FROM shared_rides s
   WHERE s.claimed_by_driver_id IS NOT NULL
     AND s.pool_state IN ('closed_full', 'closed_timeout', 'closed_started');

-- Inventory: active trip whose driver has no `driver` row (FK would fail).
INSERT INTO migration_conflict (migration, kind, subject, detail)
SELECT '0014_dispatch_offer_assignment.sql',
       'assignment_unknown_driver',
       jsonb_build_object('trip_kind', a.trip_kind, 'trip_id', a.trip_id),
       jsonb_build_object('driver_id', a.driver_id)
  FROM _active_trip a
 WHERE NOT EXISTS (SELECT 1 FROM driver d WHERE d.user_id = a.driver_id)
ON CONFLICT ON CONSTRAINT migration_conflict_once_uq DO NOTHING;

-- Inventory: driver holding more than one active trip (F06 double assignment).
INSERT INTO migration_conflict (migration, kind, subject, detail)
SELECT '0014_dispatch_offer_assignment.sql',
       'driver_multiple_active_trips',
       jsonb_build_object('driver_id', a.driver_id),
       jsonb_build_object(
         'trips',
         jsonb_agg(jsonb_build_object('trip_kind', a.trip_kind, 'trip_id', a.trip_id,
                                      'assigned_at', a.assigned_at)
                   ORDER BY a.assigned_at))
  FROM _active_trip a
 WHERE EXISTS (SELECT 1 FROM driver d WHERE d.user_id = a.driver_id)
 GROUP BY a.driver_id
HAVING count(*) > 1
ON CONFLICT ON CONSTRAINT migration_conflict_once_uq DO NOTHING;

INSERT INTO driver_active_assignment
  (driver_id, solo_ride_id, shared_ride_id, offer_id, dispatch_generation, assigned_at)
SELECT a.driver_id,
       CASE WHEN a.trip_kind = 'solo'   THEN a.trip_id END,
       CASE WHEN a.trip_kind = 'shared' THEN a.trip_id END,
       NULL,
       GREATEST(a.generation, 1),
       a.assigned_at
  FROM _active_trip a
 WHERE EXISTS (SELECT 1 FROM driver d WHERE d.user_id = a.driver_id)
   AND a.driver_id IN (
         SELECT driver_id FROM _active_trip GROUP BY driver_id HAVING count(*) = 1)
ON CONFLICT DO NOTHING;
