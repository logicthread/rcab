-- RCAB-E4.S6 — solo ride lifecycle timestamps.
--
-- The forward state machine (accepted → en_route → arrived → in_progress →
-- completed) is driven by RideStateMachine.apply(). Each transition stamps the
-- matching column below; `accepted_at` already exists (0007). No status CHECK
-- change is needed — 0006 already permits every target state. Cancellation /
-- no-show columns are deferred to RCAB-E4.S8.

ALTER TABLE rides ADD COLUMN IF NOT EXISTS en_route_at  timestamptz;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS arrived_at   timestamptz;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS started_at   timestamptz;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS completed_at timestamptz;
