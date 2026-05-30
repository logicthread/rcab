-- RCAB-E4.S4 — bind the claiming driver to a solo ride.
--
-- driver_id mirrors shared_rides.claimed_by_driver_id: a plain uuid with no FK.
-- The value is an app_user id, but at claim time an online driver may exist
-- only in the Redis geo index (active_drivers) / driver:state hash, so we do
-- not constrain it against a table. accepted_at records the winning-accept time.

ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_id   uuid;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

-- Partial index: driver/admin views look up a driver's active ride.
CREATE INDEX IF NOT EXISTS rides_driver_idx ON rides (driver_id) WHERE driver_id IS NOT NULL;
