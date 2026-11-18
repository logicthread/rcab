-- Next-ride queue: a driver on an in-progress ride who is within
-- dispatch.busyDriverEtaMs (default 10 min) of ending it may accept ONE further
-- solo ride. The accepted ride is bound to the driver (rides.driver_id, status
-- 'accepted') but is only *queued* here; driver_active_assignment (one live trip
-- per driver, F06) is untouched. When the active ride reaches a terminal state
-- the same transaction promotes the queued row into driver_active_assignment.
CREATE TABLE IF NOT EXISTS driver_queued_assignment (
  driver_id           uuid PRIMARY KEY REFERENCES driver(user_id) ON DELETE CASCADE,
  solo_ride_id        uuid NOT NULL UNIQUE REFERENCES rides(id) ON DELETE CASCADE,
  offer_id            uuid UNIQUE REFERENCES dispatch_offer(id) ON DELETE SET NULL,
  dispatch_generation integer NOT NULL CHECK (dispatch_generation >= 1),
  queued_at           timestamptz NOT NULL DEFAULT now()
);
