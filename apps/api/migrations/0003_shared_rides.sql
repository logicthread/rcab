-- Shared-ride pools. origin_centroid/dest_centroid are computed from the
-- stored lat/lng so the application never needs to format geography literals.

CREATE TABLE IF NOT EXISTS shared_rides (
  ride_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_count       int         NOT NULL DEFAULT 0,
  max_seats        int         NOT NULL DEFAULT 3,
  pool_state       text        NOT NULL DEFAULT 'open'
                               CHECK (pool_state IN
                                 ('open','closed_full','closed_started','closed_timeout','aborted')),
  pool_opened_at   timestamptz NOT NULL DEFAULT now(),
  pool_closed_at   timestamptz,
  detour_budget_m  int         NOT NULL DEFAULT 800,
  origin_lat       float8      NOT NULL,
  origin_lng       float8      NOT NULL,
  dest_lat         float8      NOT NULL,
  dest_lng         float8      NOT NULL,
  origin_centroid  geography(Point,4326)
                               GENERATED ALWAYS AS
                               (ST_SetSRID(ST_MakePoint(origin_lng, origin_lat), 4326)::geography)
                               STORED,
  dest_centroid    geography(Point,4326)
                               GENERATED ALWAYS AS
                               (ST_SetSRID(ST_MakePoint(dest_lng, dest_lat), 4326)::geography)
                               STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shared_rides_origin_gist ON shared_rides USING GIST (origin_centroid);
CREATE INDEX IF NOT EXISTS shared_rides_dest_gist   ON shared_rides USING GIST (dest_centroid);
CREATE INDEX IF NOT EXISTS shared_rides_state_idx   ON shared_rides (pool_state)
  WHERE pool_state = 'open';
