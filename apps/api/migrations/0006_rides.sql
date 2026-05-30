-- Solo (normal) rides. Created in 'requested' state by RCAB-E4.S2; the full
-- state machine (en_route → arrived → …) is owned by RCAB-E4.S6, which extends
-- this table. Shared rides live in shared_rides (RCAB-E5) — kept separate.

CREATE TABLE IF NOT EXISTS rides (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id     uuid        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  origin_lat       float8      NOT NULL,
  origin_lng       float8      NOT NULL,
  dest_lat         float8      NOT NULL,
  dest_lng         float8      NOT NULL,
  fare_cents       int         NOT NULL,
  status           text        NOT NULL DEFAULT 'requested'
                               CHECK (status IN
                                 ('requested','dispatching','accepted','en_route',
                                  'arrived','in_progress','completed','cancelled','no_driver')),
  idempotency_key  text        NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rides_passenger_idx ON rides (passenger_id);
-- Partial index for the dispatcher (RCAB-E4.S3) to scan freshly-requested rides.
CREATE INDEX IF NOT EXISTS rides_requested_idx ON rides (status) WHERE status = 'requested';
