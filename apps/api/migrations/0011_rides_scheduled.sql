-- RCAB-E6.S2 — scheduled booking columns on the rides table.
--
-- A 'scheduled' ride is placed now for a future window (15 min – 24 h out) and
-- carries scheduled_for; a BullMQ delayed job (queue `scheduled-dispatch`) wakes
-- it ~10 min before pickup and runs the normal dispatch path (E6.S3). 'normal'
-- and 'shared' rides dispatch immediately (unchanged).
--
-- Additive + backward-compatible: `type` defaults to 'normal' so every existing
-- row keeps its current behaviour; scheduled_for is nullable (only set for
-- scheduled rides). ADD COLUMN … DEFAULT <const> is a fast metadata-only change
-- on modern Postgres (no table rewrite).

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;

ALTER TABLE rides
  DROP CONSTRAINT IF EXISTS rides_type_check;
ALTER TABLE rides
  ADD CONSTRAINT rides_type_check CHECK (type IN ('normal', 'shared', 'scheduled'));
