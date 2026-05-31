-- RCAB-E4.S8 — solo ride cancellation & no-show terminal paths.
--
-- Adds the cancellation bookkeeping columns and the `no_show` status. Both
-- client- and driver-initiated cancellation land on `cancelled` (discriminated
-- by `cancelled_by`); a driver no-show after the 5-min wait lands on `no_show`.
-- No fee column ships in Phase-0 — cancellation is free and the fee mechanism
-- is deferred to a later phase (HITL decision 2026-05-31).

ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_at  timestamptz;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_by  text;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancel_reason text;

ALTER TABLE rides ADD CONSTRAINT rides_cancelled_by_check
  CHECK (cancelled_by IS NULL OR cancelled_by IN ('client','driver'));

-- Extend the status CHECK with `no_show` (0006 already permits `cancelled`).
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_status_check;
ALTER TABLE rides ADD CONSTRAINT rides_status_check
  CHECK (status IN
    ('requested','dispatching','accepted','en_route','arrived',
     'in_progress','completed','cancelled','no_driver','no_show'));
