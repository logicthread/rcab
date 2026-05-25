-- Initial schema: app_user, client, driver, vehicle
-- Extensions (postgis, uuid-ossp) are created by init.sql at container startup.

CREATE TABLE IF NOT EXISTS app_user (
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
CREATE INDEX IF NOT EXISTS app_user_phone_idx ON app_user (phone_e164);

CREATE TABLE IF NOT EXISTS client (
  user_id       uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  home_label    text,
  work_label    text,
  rating_avg    numeric(3,2),
  rating_count  int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver (
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

CREATE TABLE IF NOT EXISTS vehicle (
  id         uuid PRIMARY KEY,
  driver_id  uuid NOT NULL REFERENCES driver(user_id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('auto','bike','cab_hatch','cab_sedan')),
  reg_no     text NOT NULL UNIQUE,
  make       text,
  model      text,
  color      text,
  seats      int NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE driver
  ADD CONSTRAINT fk_driver_vehicle
  FOREIGN KEY (current_vehicle_id) REFERENCES vehicle(id) DEFERRABLE INITIALLY DEFERRED;
