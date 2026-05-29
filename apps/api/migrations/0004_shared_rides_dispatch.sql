-- E5.S4: shared-ride dispatch outcome — per-pool driver claim + per-passenger
-- stop list. `members` is a JSONB array of
-- `{ passenger_id, origin_lat, origin_lng, dest_lat, dest_lng, joined_at }`
-- entries; the opener seeds members[0] and each slotted joiner appends one.
-- `claimed_by_driver_id` + `claimed_at` are written by `pool_claim.lua` when
-- a driver wins the dispatch offer; they stay NULL for pools that abort.

ALTER TABLE shared_rides
  ADD COLUMN IF NOT EXISTS members
    jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE shared_rides
  ADD COLUMN IF NOT EXISTS claimed_by_driver_id uuid;

ALTER TABLE shared_rides
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS shared_rides_claimed_driver_idx
  ON shared_rides (claimed_by_driver_id)
  WHERE claimed_by_driver_id IS NOT NULL;
