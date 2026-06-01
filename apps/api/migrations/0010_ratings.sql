-- RCAB-E4.S9 — two-sided rating capture (post-completion prompt).
--
-- One row per (ride, rater, subject): a rater scores the OTHER party of a
-- completed ride 1..5 stars with optional text. Direction is resolved at the
-- API from the ride row (client -> driver, driver -> client). The unique key
-- enforces one rating per direction per ride; the CHECK forbids self-rating.
-- Plain uuid refs (no cross-table FK — mirrors rides.driver_id).
--
-- Capture ONLY. Aggregation (weighted-recency mean, user.rating_avg/_count)
-- and the read surfaces (history, dashboards, moderation) are deferred to
-- Epic E7 / Demo 6.

CREATE TABLE IF NOT EXISTS ratings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id    uuid NOT NULL,
  rater_id   uuid NOT NULL,
  subject_id uuid NOT NULL,
  stars      smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ratings_no_self_check CHECK (rater_id <> subject_id),
  CONSTRAINT ratings_unique_direction UNIQUE (ride_id, rater_id, subject_id)
);

CREATE INDEX IF NOT EXISTS ratings_subject_idx ON ratings (subject_id, created_at DESC);
