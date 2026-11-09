-- Resolve ONE migration_conflict row of kind driver_multiple_active_trips (migration 0014).
--
-- Why it exists: before 0014 nothing stopped a driver holding two active trips. 0014 therefore
-- gave such a driver NO driver_active_assignment guard row and recorded the situation in
-- migration_conflict. Until an operator decides, that driver's trips run unguarded.
--
-- The operator (a human who has talked to the driver / checked the trips) decides which ONE
-- trip stays with the driver. This script then, in a single transaction:
--   1. asserts the conflict is open and the chosen trip really is this driver's active trip
--   2. creates the guard row for the kept trip
--   3. cancels the OTHER trip (a solo ride; see "Shared trips" below)
--   4. marks the conflict resolved
-- Any failed assertion aborts the whole transaction (a "division by zero" error whose column
-- alias starts with "assert:" names the failed check). Nothing is auto-cancelled by the
-- migration or by this script unless you run it.
--
-- Usage (psql against the production database, after taking a fresh backup):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -v driver_id=<driver uuid> \
--        -v keep_kind=solo|shared -v keep_trip=<rides.id | shared_rides.ride_id to KEEP> \
--        -v drop_trip=<rides.id of the solo ride to CANCEL> \
--        -f scripts/recovery/resolve-driver-conflict.sql
--
-- Shared trips: this script only cancels SOLO rides. If the trip to drop is a pool
-- (shared_rides), do NOT edit it by SQL: its members, seat count, outbox intent and Redis
-- projection are maintained by the application. Keep the pool (keep_kind=shared) and cancel the
-- solo ride instead, or release the pool through the application's cancel/dispatch path.
-- The passenger of the cancelled ride is not notified by SQL; tell support/the passenger.

\set ON_ERROR_STOP on
BEGIN;

SELECT (:'keep_kind' = 'solo') AS keep_is_solo \gset

SELECT 1 / (CASE WHEN EXISTS (
         SELECT 1 FROM migration_conflict
          WHERE migration = '0014_dispatch_offer_assignment.sql'
            AND kind = 'driver_multiple_active_trips'
            AND resolved_at IS NULL
            AND subject ->> 'driver_id' = :'driver_id') THEN 1 ELSE 0 END)
       AS "assert: conflict is open for driver";

SELECT 1 / (CASE WHEN NOT EXISTS (
         SELECT 1 FROM driver_active_assignment WHERE driver_id = :'driver_id'::uuid) THEN 1 ELSE 0 END)
       AS "assert: no guard row yet";

\if :keep_is_solo
  SELECT 1 / (CASE WHEN EXISTS (
           SELECT 1 FROM rides WHERE id = :'keep_trip'::uuid AND driver_id = :'driver_id'::uuid
              AND status IN ('accepted','en_route','arrived','in_progress')) THEN 1 ELSE 0 END)
         AS "assert: keep_trip is driver solo ride";

  INSERT INTO driver_active_assignment (driver_id, solo_ride_id, dispatch_generation, assigned_at)
  SELECT r.driver_id, r.id, GREATEST(r.dispatch_generation, 1), COALESCE(r.accepted_at, r.updated_at)
    FROM rides r WHERE r.id = :'keep_trip'::uuid;
\else
  SELECT 1 / (CASE WHEN EXISTS (
           SELECT 1 FROM shared_rides WHERE ride_id = :'keep_trip'::uuid
              AND claimed_by_driver_id = :'driver_id'::uuid
              AND pool_state IN ('closed_full','closed_timeout','closed_started')) THEN 1 ELSE 0 END)
         AS "assert: keep_trip is driver pool";

  INSERT INTO driver_active_assignment (driver_id, shared_ride_id, dispatch_generation, assigned_at)
  SELECT s.claimed_by_driver_id, s.ride_id, GREATEST(s.dispatch_generation, 1), COALESCE(s.claimed_at, s.updated_at)
    FROM shared_rides s WHERE s.ride_id = :'keep_trip'::uuid;
\endif

WITH cancelled AS (
  UPDATE rides
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'driver',
         cancel_reason = 'migration_conflict: duplicate driver assignment resolved by operator',
         updated_at = now()
   WHERE id = :'drop_trip'::uuid
     AND driver_id = :'driver_id'::uuid
     AND status IN ('accepted','en_route','arrived','in_progress')
     AND id <> :'keep_trip'::uuid
  RETURNING id)
SELECT 1 / count(*) AS "assert: drop_trip cancelled" FROM cancelled;

UPDATE migration_conflict
   SET resolved_at = now(),
       resolution = format('operator kept %s %s, cancelled solo ride %s', :'keep_kind', :'keep_trip', :'drop_trip')
 WHERE migration = '0014_dispatch_offer_assignment.sql'
   AND kind = 'driver_multiple_active_trips'
   AND resolved_at IS NULL
   AND subject ->> 'driver_id' = :'driver_id';

COMMIT;
\echo resolved: driver :driver_id keeps :keep_kind trip :keep_trip, ride :drop_trip cancelled
