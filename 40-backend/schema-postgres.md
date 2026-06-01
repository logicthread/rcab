---
title: Postgres schema (Phase-0)
tags: [layer/backend, kind/diagram]
status: accepted
phase: 0
depends_on: [[data-model]]
related: [[entity-user]], [[entity-client]], [[entity-driver]], [[entity-vehicle]], [[entity-ride]], [[entity-ride-request]], [[entity-shared-ride]], [[entity-route]], [[entity-rating]], [[entity-location]], [[entity-notification]], [[migrations]]
audience: both
---

# Postgres schema (Phase-0)

*Indicative DDL. Authoritative DDL lives in `apps/api/migrations/` when generated. Always cross-check against the entity notes when changing.*

## Extensions

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- or use uuid_v7() helper
```

## Tables

```sql
-- USERS (auth-level)
CREATE TABLE app_user (
  id            uuid PRIMARY KEY,
  firebase_uid  text NOT NULL UNIQUE,
  phone_e164    text NOT NULL UNIQUE,
  google_sub    text UNIQUE,
  email         text,
  display_name  text,
  role          text NOT NULL CHECK (role IN ('client','driver')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON app_user (phone_e164);

-- CLIENT profile
CREATE TABLE client (
  user_id       uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  home_label    text,
  home_point    geography(Point,4326),
  work_label    text,
  work_point    geography(Point,4326),
  rating_avg    numeric(3,2),
  rating_count  int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- DRIVER profile
CREATE TABLE driver (
  user_id            uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  license_no         text,
  verified_at        timestamptz,
  availability       text NOT NULL DEFAULT 'offline'
                       CHECK (availability IN ('offline','online','on_ride')),
  current_vehicle_id uuid,
  rating_avg         numeric(3,2),
  rating_count       int NOT NULL DEFAULT 0,
  total_rides        int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- VEHICLE
CREATE TABLE vehicle (
  id        uuid PRIMARY KEY,
  driver_id uuid NOT NULL REFERENCES driver(user_id) ON DELETE CASCADE,
  type      text NOT NULL CHECK (type IN ('auto','bike','cab_hatch','cab_sedan')),
  reg_no    text NOT NULL UNIQUE,
  make      text,
  model     text,
  color     text,
  seats     int NOT NULL,
  active    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE driver
  ADD CONSTRAINT fk_driver_vehicle
  FOREIGN KEY (current_vehicle_id) REFERENCES vehicle(id) DEFERRABLE INITIALLY DEFERRED;

-- ROUTE (emergent corridor)
CREATE TABLE route (
  id                 uuid PRIMARY KEY,
  origin_cell        text NOT NULL,        -- geohash p6
  dest_cell          text NOT NULL,        -- geohash p6
  canonical_polyline text NOT NULL,
  samples_count      int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (origin_cell, dest_cell)
);

-- RIDE
CREATE TABLE ride (
  id                 uuid PRIMARY KEY,
  driver_id          uuid NOT NULL REFERENCES driver(user_id),
  vehicle_id         uuid NOT NULL REFERENCES vehicle(id),
  type               text NOT NULL CHECK (type IN ('solo','shared')),
  state              text NOT NULL,
  origin_summary     jsonb NOT NULL,
  dest_summary       jsonb NOT NULL,
  route_polyline     text,
  est_distance_m     int,
  est_duration_s     int,
  actual_distance_m  int,
  actual_duration_s  int,
  total_fare         numeric(10,2),
  platform_commission numeric(10,2),
  driver_payout      numeric(10,2),
  started_at         timestamptz,
  completed_at       timestamptz,
  canceled_at        timestamptz,
  cancel_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ride (driver_id, created_at DESC);
CREATE INDEX ON ride (state);
```

> **As-built — solo `rides` table (migrations 0006–0009).** The shipped solo-ride table is named **`rides`** (distinct from the indicative `ride` above and from `shared_rides`). It uses `status` (not `state`) with CHECK `('requested','dispatching','accepted','en_route','arrived','in_progress','completed','cancelled','no_driver','no_show')`, `fare_cents int`, per-state timestamp columns (`accepted_at`/`en_route_at`/`arrived_at`/`started_at`/`completed_at`), and — from **migration 0009 (RCAB-E4.S8)** — the cancellation columns `cancelled_at timestamptz`, `cancelled_by text CHECK (… IN ('client','driver'))`, `cancel_reason text`. **No fee column** ships in Phase-0 (cancellation is free; the fee mechanism is deferred to a later phase).

```sql

-- SHARED RIDE
CREATE TABLE shared_ride (
  ride_id          uuid PRIMARY KEY REFERENCES ride(id) ON DELETE CASCADE,
  route_id         uuid REFERENCES route(id),
  seat_count       int NOT NULL DEFAULT 0,
  max_seats        int NOT NULL DEFAULT 3,
  pool_opened_at   timestamptz NOT NULL DEFAULT now(),
  pool_closed_at   timestamptz,
  detour_budget_m  int NOT NULL DEFAULT 800,
  origin_centroid  geography(Point,4326) NOT NULL,
  dest_centroid    geography(Point,4326) NOT NULL
);
CREATE INDEX ON shared_ride USING GIST (origin_centroid);
CREATE INDEX ON shared_ride USING GIST (dest_centroid);

-- RIDE REQUEST
CREATE TABLE ride_request (
  id              uuid PRIMARY KEY,
  client_id       uuid NOT NULL REFERENCES client(user_id),
  type            text NOT NULL CHECK (type IN ('normal','shared','scheduled')),
  state           text NOT NULL,
  origin_point    geography(Point,4326) NOT NULL,
  origin_label    text,
  dest_point      geography(Point,4326) NOT NULL,
  dest_label      text,
  scheduled_for   timestamptz,
  fare_estimate   numeric(10,2),
  ride_id         uuid REFERENCES ride(id),
  pool_seat_index int,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ride_request (client_id, created_at DESC);
CREATE INDEX ON ride_request (ride_id);
CREATE INDEX ON ride_request (state);

-- RATING
CREATE TABLE rating (
  id          uuid PRIMARY KEY,
  ride_id     uuid NOT NULL REFERENCES ride(id) ON DELETE CASCADE,
  rater_id    uuid NOT NULL REFERENCES app_user(id),
  subject_id  uuid NOT NULL REFERENCES app_user(id),
  stars       smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ride_id, rater_id, subject_id),
  CHECK (rater_id <> subject_id)
);
CREATE INDEX ON rating (subject_id, created_at DESC);
-- AS-BUILT (RCAB-E4.S9): shipped as table `ratings` (plural) via migration 0010,
-- same columns/constraints as above EXCEPT ride_id/rater_id/subject_id are plain
-- uuid (no FK — mirrors rides.driver_id). Capture only; aggregation + the denorm
-- to user.rating_avg/_count is Epic E7.

-- RIDE LOCATION SAMPLE
CREATE TABLE ride_location_sample (
  ride_id   uuid NOT NULL REFERENCES ride(id) ON DELETE CASCADE,
  ts        timestamptz NOT NULL,
  point     geography(Point,4326) NOT NULL,
  speed_mps real,
  PRIMARY KEY (ride_id, ts)
);

-- NOTIFICATION
CREATE TABLE notification (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  channel    text NOT NULL,
  payload    jsonb NOT NULL,
  sent_at    timestamptz,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notification (user_id, created_at DESC);
```

## Constraints worth noting

- `app_user.role` is exclusive in Phase-0 — no compound (client+driver) accounts.
- `ride_request.ride_id` is nullable (set on match) but a unique partial index could be added if we ever need it.
- `shared_ride` rows always have a paired `ride` row (FK PK).

## Indexing rationale

We index for the hot queries:

- "my rides" for both clients and drivers → `(client_id|driver_id, created_at DESC)`.
- "rides in state X" for ops dashboards → `ride.state`.
- Spatial indexes on shared_ride centroids for matching candidate lookups.
- We do **not** index `ride_request.origin_point` because matching candidates come from the `shared_ride` index first.

## See also
- [[data-model]] · [[migrations]] · [[redis-usage]]
- Entities: [[entity-user]], [[entity-driver]], [[entity-ride]], [[entity-ride-request]], [[entity-shared-ride]]
