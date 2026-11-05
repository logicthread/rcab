-- F09 / F15 (R08) — pool membership, capacity and state as one Postgres
-- invariant.
--
-- Before: Lua reserved a seat in Redis, then Postgres got an ABSOLUTE
-- seat_count write, then a separate jsonb `members` append, then more Redis
-- writes — no transaction. Interleavings left seat_count behind the member
-- list, a failure could leave a seat with no member, and a closed pool could
-- still be joined.
--
-- After (Phase-0 contract: ONE seat per member; group bookings would need an
-- explicit seats_requested model):
--   * `pool_member` is the authoritative membership: PK (pool_id, passenger_id)
--     so a passenger is in a pool at most once, and a partial UNIQUE on
--     passenger_id WHERE active so a passenger holds at most one non-terminal
--     pool seat at a time.
--   * shared_rides.seat_count is DERIVED: a trigger adds/subtracts the member's
--     seats on INSERT/DELETE of pool_member. The app never writes seat_count.
--     CHECK (seat_count BETWEEN 0 AND max_seats) makes an oversubscribing
--     INSERT fail atomically (SQLSTATE 23514, constraint
--     shared_rides_seat_capacity_check) even if a writer forgot to lock.
--   * A BEFORE INSERT trigger rejects a member for a pool whose state is not
--     'open' (SQLSTATE 23514, constraint pool_member_pool_open) — a stale
--     candidate cannot join a pool that closed after it was scored.
--   * pool_member.active flips to false (trigger) when the pool reaches a
--     terminal state ('aborted' / 'completed'), releasing the passenger's
--     one-active-pool slot.
--   * shared_rides.state_version increments on every UPDATE (trigger); Redis
--     pool projections carry it and a writer never overwrites a newer version.
--   * pool_member.idempotency_key durably links a shared-create idempotency
--     claim to the seat it produced (replaces the passenger+time heuristic).
--   * pool_member.quoted_fare_cents records the per-seat price quoted at join.
--     The final shared-fare policy (F15) is still an owner decision; this
--     column only preserves the number the passenger was shown.
--
-- Lock order: shared_rides row (FOR UPDATE) → pool_member. The seat trigger
-- updates the parent row, so a writer that did not lock first still serializes
-- on it.
--
-- `shared_rides.members` (jsonb) is kept, deprecated and no longer written by
-- the Stage-C code; readers derive members from pool_member. Dropping it is a
-- later migration.
--
-- Backfill: members jsonb → pool_member. Anything that cannot be copied
-- mechanically is recorded in migration_conflict (from 0014), never silently
-- dropped:
--   pool_member_malformed             entry lacks passenger/coords
--   pool_member_unknown_passenger     passenger has no app_user row (FK)
--   pool_member_duplicate_in_pool     same passenger listed twice in one pool
--   passenger_multiple_active_pools   passenger in >1 non-terminal pool: only the
--                                     newest-joined keeps active=true (pool rows
--                                     are NOT modified; operator resolves)
--   pool_over_capacity                more valid members than max_seats:
--                                     max_seats raised to the member count
--   pool_seat_count_mismatch          seat_count ≠ member count (F09): seat_count
--                                     set to the member count (membership is the
--                                     authority; Redis is not copied)
--
-- Rollout: ships together with the Stage-C pool code (same deploy). The
-- pre-Stage-C api would keep writing jsonb/seat_count and never pool_member.

CREATE TABLE IF NOT EXISTS pool_member (
  pool_id            uuid        NOT NULL REFERENCES shared_rides(ride_id) ON DELETE CASCADE,
  passenger_id       uuid        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  seats              smallint    NOT NULL DEFAULT 1,
  origin_lat         float8      NOT NULL,
  origin_lng         float8      NOT NULL,
  dest_lat           float8      NOT NULL,
  dest_lng           float8      NOT NULL,
  quoted_fare_cents  int,
  idempotency_key    text,
  active             boolean     NOT NULL DEFAULT true,
  joined_at          timestamptz NOT NULL DEFAULT now(),
  left_at            timestamptz,
  PRIMARY KEY (pool_id, passenger_id),
  CONSTRAINT pool_member_one_seat_check CHECK (seats = 1),
  CONSTRAINT pool_member_fare_check CHECK (quoted_fare_cents IS NULL OR quoted_fare_cents >= 0),
  CONSTRAINT pool_member_left_check CHECK (active = (left_at IS NULL)),
  CONSTRAINT pool_member_idempotency_uq UNIQUE (passenger_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS pool_member_passenger_idx ON pool_member (passenger_id, joined_at DESC);

ALTER TABLE shared_rides
  ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 0;

-- ── Backfill members jsonb → pool_member ───────────────────────────────────

CREATE TEMP TABLE _legacy_member ON COMMIT DROP AS
  SELECT s.ride_id                              AS pool_id,
         s.pool_state,
         s.created_at                           AS pool_created_at,
         e.ord,
         e.elem,
         CASE WHEN (e.elem->>'passenger_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (e.elem->>'passenger_id')::uuid END AS passenger_id
    FROM shared_rides s
   CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(s.members) = 'array' THEN s.members ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS e(elem, ord);

INSERT INTO migration_conflict (migration, kind, subject, detail)
SELECT '0016_pool_membership.sql', 'pool_member_malformed',
       jsonb_build_object('pool_id', l.pool_id, 'ord', l.ord), l.elem
  FROM _legacy_member l
 WHERE l.passenger_id IS NULL
    OR jsonb_typeof(l.elem->'origin_lat') IS DISTINCT FROM 'number'
    OR jsonb_typeof(l.elem->'origin_lng') IS DISTINCT FROM 'number'
    OR jsonb_typeof(l.elem->'dest_lat')   IS DISTINCT FROM 'number'
    OR jsonb_typeof(l.elem->'dest_lng')   IS DISTINCT FROM 'number'
ON CONFLICT ON CONSTRAINT migration_conflict_once_uq DO NOTHING;

DELETE FROM _legacy_member l
 WHERE l.passenger_id IS NULL
    OR jsonb_typeof(l.elem->'origin_lat') IS DISTINCT FROM 'number'
    OR jsonb_typeof(l.elem->'origin_lng') IS DISTINCT FROM 'number'
    OR jsonb_typeof(l.elem->'dest_lat')   IS DISTINCT FROM 'number'
    OR jsonb_typeof(l.elem->'dest_lng')   IS DISTINCT FROM 'number';

INSERT INTO migration_conflict (migration, kind, subject, detail)
SELECT '0016_pool_membership.sql', 'pool_member_unknown_passenger',
       jsonb_build_object('pool_id', l.pool_id, 'passenger_id', l.passenger_id), l.elem
  FROM _legacy_member l
 WHERE NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = l.passenger_id)
ON CONFLICT ON CONSTRAINT migration_conflict_once_uq DO NOTHING;

DELETE FROM _legacy_member l
 WHERE NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = l.passenger_id);

INSERT INTO migration_conflict (migration, kind, subject, detail)
SELECT '0016_pool_membership.sql', 'pool_member_duplicate_in_pool',
       jsonb_build_object('pool_id', l.pool_id, 'passenger_id', l.passenger_id),
       jsonb_build_object('entries', jsonb_agg(l.elem ORDER BY l.ord), 'kept_ord', min(l.ord))
  FROM _legacy_member l
 GROUP BY l.pool_id, l.passenger_id
HAVING count(*) > 1
ON CONFLICT ON CONSTRAINT migration_conflict_once_uq DO NOTHING;

-- First listed entry wins inside one pool (the jsonb order is the append order).
INSERT INTO pool_member
  (pool_id, passenger_id, seats, origin_lat, origin_lng, dest_lat, dest_lng,
   active, joined_at, left_at)
SELECT DISTINCT ON (l.pool_id, l.passenger_id)
       l.pool_id,
       l.passenger_id,
       1,
       (l.elem->>'origin_lat')::float8,
       (l.elem->>'origin_lng')::float8,
       (l.elem->>'dest_lat')::float8,
       (l.elem->>'dest_lng')::float8,
       l.pool_state NOT IN ('aborted', 'completed'),
       COALESCE(
         CASE WHEN (l.elem->>'joined_at') ~ '^\d{4}-\d{2}-\d{2}T'
              THEN (l.elem->>'joined_at')::timestamptz END,
         l.pool_created_at),
       CASE WHEN l.pool_state IN ('aborted', 'completed') THEN now() END
  FROM _legacy_member l
 ORDER BY l.pool_id, l.passenger_id, l.ord
ON CONFLICT (pool_id, passenger_id) DO NOTHING;

-- A passenger in more than one non-terminal pool: keep the newest-joined seat
-- active, deactivate the rest, record all of them.
INSERT INTO migration_conflict (migration, kind, subject, detail)
SELECT '0016_pool_membership.sql', 'passenger_multiple_active_pools',
       jsonb_build_object('passenger_id', m.passenger_id),
       jsonb_build_object(
         'pools', jsonb_agg(jsonb_build_object('pool_id', m.pool_id, 'joined_at', m.joined_at)
                            ORDER BY m.joined_at DESC, m.pool_id),
         'kept_active', (array_agg(m.pool_id ORDER BY m.joined_at DESC, m.pool_id))[1])
  FROM pool_member m
 WHERE m.active
 GROUP BY m.passenger_id
HAVING count(*) > 1
ON CONFLICT ON CONSTRAINT migration_conflict_once_uq DO NOTHING;

UPDATE pool_member m
   SET active = false, left_at = now()
  FROM (
    SELECT pool_id, passenger_id,
           row_number() OVER (PARTITION BY passenger_id
                              ORDER BY joined_at DESC, pool_id) AS rn
      FROM pool_member
     WHERE active
  ) ranked
 WHERE ranked.rn > 1
   AND m.pool_id = ranked.pool_id
   AND m.passenger_id = ranked.passenger_id;

-- Capacity + derived seat_count.
CREATE TEMP TABLE _pool_count ON COMMIT DROP AS
  SELECT s.ride_id AS pool_id,
         s.seat_count,
         s.max_seats,
         COALESCE((SELECT sum(m.seats)::int FROM pool_member m WHERE m.pool_id = s.ride_id), 0)
           AS member_seats
    FROM shared_rides s;

INSERT INTO migration_conflict (migration, kind, subject, detail)
SELECT '0016_pool_membership.sql', 'pool_over_capacity',
       jsonb_build_object('pool_id', c.pool_id),
       jsonb_build_object('max_seats', c.max_seats, 'member_seats', c.member_seats)
  FROM _pool_count c
 WHERE c.member_seats > c.max_seats
ON CONFLICT ON CONSTRAINT migration_conflict_once_uq DO NOTHING;

INSERT INTO migration_conflict (migration, kind, subject, detail)
SELECT '0016_pool_membership.sql', 'pool_seat_count_mismatch',
       jsonb_build_object('pool_id', c.pool_id),
       jsonb_build_object('seat_count', c.seat_count, 'member_seats', c.member_seats)
  FROM _pool_count c
 WHERE c.seat_count <> c.member_seats
ON CONFLICT ON CONSTRAINT migration_conflict_once_uq DO NOTHING;

UPDATE shared_rides s
   SET max_seats  = GREATEST(s.max_seats, c.member_seats),
       seat_count = c.member_seats
  FROM _pool_count c
 WHERE c.pool_id = s.ride_id
   AND (s.seat_count <> c.member_seats OR s.max_seats < c.member_seats);

-- ── Constraints (after the data is consistent) ─────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS pool_member_one_active_pool_uq
  ON pool_member (passenger_id)
  WHERE active;

ALTER TABLE shared_rides
  DROP CONSTRAINT IF EXISTS shared_rides_max_seats_check;
ALTER TABLE shared_rides
  ADD CONSTRAINT shared_rides_max_seats_check CHECK (max_seats >= 1);

ALTER TABLE shared_rides
  DROP CONSTRAINT IF EXISTS shared_rides_seat_capacity_check;
ALTER TABLE shared_rides
  ADD CONSTRAINT shared_rides_seat_capacity_check
  CHECK (seat_count >= 0 AND seat_count <= max_seats);

-- ── Triggers ───────────────────────────────────────────────────────────────

-- New members only join an open pool. Locks the parent row (lock order:
-- shared_rides → pool_member) so the state read is the one the insert commits
-- against.
CREATE OR REPLACE FUNCTION pool_member_require_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  SELECT pool_state INTO st FROM shared_rides WHERE ride_id = NEW.pool_id FOR UPDATE;
  IF st IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'pool % is not open (state %)', NEW.pool_id, COALESCE(st, 'missing')
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'pool_member_pool_open',
            TABLE = 'pool_member';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pool_member_require_open_trg ON pool_member;
CREATE TRIGGER pool_member_require_open_trg
  BEFORE INSERT ON pool_member
  FOR EACH ROW EXECUTE FUNCTION pool_member_require_open();

-- seat_count is derived from membership. The capacity CHECK on shared_rides
-- fires inside this UPDATE, so an oversubscribing INSERT fails atomically.
CREATE OR REPLACE FUNCTION pool_member_sync_seat_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE shared_rides
       SET seat_count = seat_count + NEW.seats, updated_at = now()
     WHERE ride_id = NEW.pool_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE shared_rides
       SET seat_count = seat_count - OLD.seats, updated_at = now()
     WHERE ride_id = OLD.pool_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS pool_member_sync_seat_count_trg ON pool_member;
CREATE TRIGGER pool_member_sync_seat_count_trg
  AFTER INSERT OR DELETE ON pool_member
  FOR EACH ROW EXECUTE FUNCTION pool_member_sync_seat_count();

-- Membership identity is immutable (re-home = delete + insert).
CREATE OR REPLACE FUNCTION pool_member_immutable_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pool_id <> OLD.pool_id OR NEW.passenger_id <> OLD.passenger_id OR NEW.seats <> OLD.seats THEN
    RAISE EXCEPTION 'pool_member identity/seats are immutable'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'pool_member_immutable',
            TABLE = 'pool_member';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pool_member_immutable_identity_trg ON pool_member;
CREATE TRIGGER pool_member_immutable_identity_trg
  BEFORE UPDATE ON pool_member
  FOR EACH ROW EXECUTE FUNCTION pool_member_immutable_identity();

-- Terminal pool → release every member's one-active-pool slot.
CREATE OR REPLACE FUNCTION shared_rides_release_members() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pool_member
     SET active = false, left_at = now()
   WHERE pool_id = NEW.ride_id
     AND active;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS shared_rides_release_members_trg ON shared_rides;
CREATE TRIGGER shared_rides_release_members_trg
  AFTER UPDATE OF pool_state ON shared_rides
  FOR EACH ROW
  WHEN (NEW.pool_state IN ('aborted', 'completed')
        AND OLD.pool_state IS DISTINCT FROM NEW.pool_state)
  EXECUTE FUNCTION shared_rides_release_members();

-- Monotonic version for Redis projections.
CREATE OR REPLACE FUNCTION shared_rides_bump_state_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.state_version := OLD.state_version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shared_rides_bump_state_version_trg ON shared_rides;
CREATE TRIGGER shared_rides_bump_state_version_trg
  BEFORE UPDATE ON shared_rides
  FOR EACH ROW EXECUTE FUNCTION shared_rides_bump_state_version();
