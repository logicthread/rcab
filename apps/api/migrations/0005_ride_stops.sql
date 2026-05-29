-- E5.S7: per-passenger stop sequence for shared rides.
-- `ride_stops` is populated by DispatchService.dispatchPool when a pool is
-- assigned to a driver; rows mirror the cached `pool:<id>:stops` Redis list.
-- Each row is confirmed independently by the driver via the
-- `stop:pickup_confirmed` / `stop:drop_confirmed` WS events.
--
-- `shared_rides.pool_state` gains the terminal value `completed`.
-- `closed_started` is set on the first pickup confirmation; `completed` is set
-- when the last drop is confirmed. `completed_at` is the wall-clock for the
-- terminal transition; the per-stop `confirmed_at` carries each intermediate
-- step.

CREATE TABLE IF NOT EXISTS ride_stops (
  ride_id        uuid        NOT NULL REFERENCES shared_rides(ride_id) ON DELETE CASCADE,
  sequence_index int         NOT NULL,
  passenger_id   uuid        NOT NULL,
  type           text        NOT NULL CHECK (type IN ('pickup','dropoff')),
  lat            float8      NOT NULL,
  lng            float8      NOT NULL,
  confirmed_at   timestamptz,
  PRIMARY KEY (ride_id, sequence_index)
);

CREATE INDEX IF NOT EXISTS ride_stops_pending_idx
  ON ride_stops (ride_id, sequence_index)
  WHERE confirmed_at IS NULL;

ALTER TABLE shared_rides
  DROP CONSTRAINT IF EXISTS shared_rides_pool_state_check;

ALTER TABLE shared_rides
  ADD CONSTRAINT shared_rides_pool_state_check
    CHECK (pool_state IN
      ('open','closed_full','closed_started','closed_timeout','aborted','completed'));

ALTER TABLE shared_rides
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;
