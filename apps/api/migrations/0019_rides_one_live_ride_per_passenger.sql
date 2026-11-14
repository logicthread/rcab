-- RCAB-E8.S15 walkthrough -- a passenger holds at most ONE live immediate ride.
--
-- Found walking the passenger flows: nothing stopped a second "now" ride while
-- one was still requested..in_progress (a second tab, or the old "New booking"
-- button mid-ride, with a fresh Idempotency-Key), so two drivers could be
-- dispatched to one person. The API pre-checks and answers
-- 409 passenger_has_active_ride; this partial unique index is the race-proof
-- backstop (two concurrent requests cannot both commit).
--
-- Scope: type = 'normal' only. Scheduled rides are booked ahead and may
-- coexist; shared seats are already limited by pool_member_one_active_pool_uq.
--
-- Fails loudly (instead of silently cancelling anyone's ride) if a database
-- already holds two live normal rides for one passenger; resolve those rows
-- (cancel the stale one) and re-run.

DO $$
DECLARE dup integer;
BEGIN
  SELECT count(*) INTO dup FROM (
    SELECT passenger_id FROM rides
    WHERE type = 'normal'
      AND status IN ('requested','dispatching','accepted','en_route','arrived','in_progress')
    GROUP BY passenger_id HAVING count(*) > 1
  ) d;
  IF dup > 0 THEN
    RAISE EXCEPTION '0019: % passenger(s) hold more than one live normal ride; cancel the stale rides and re-run', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS rides_one_live_normal_per_passenger_uq
  ON rides (passenger_id)
  WHERE type = 'normal'
    AND status IN ('requested','dispatching','accepted','en_route','arrived','in_progress');
