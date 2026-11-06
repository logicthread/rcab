-- F15 (fare half) / R10 -- Phase-0 STAND-IN shared fare policy `fixed_at_join`.
--
-- Each pool member's shared fare is FIXED at join: it is quoted at the moment
-- of seat allocation, inside the join transaction, from the locked pool state
-- (seat count after this join) and the ordered multi-stop itinerary, and
-- persisted here. Later joins never readjust an earlier member's fare.
--
--   * pool_member.agreed_fare_cents  integer paise (INR), >= 0. This is what the
--     passenger agreed to pay; receipts/history read it instead of recomputing
--     with today's tariff.
--   * NOT NULL for every NEW member (BEFORE INSERT trigger). Legacy rows
--     written before this migration may stay NULL (quoted_fare_cents was
--     optional and a pricing failure used to be swallowed), so the column is
--     nullable and no table-wide NOT NULL / NOT VALID check is used (that would
--     break trigger-driven UPDATEs of legacy rows such as active=false).
--   * Immutable once set (BEFORE UPDATE trigger): "fixed at join" is a database
--     guarantee, not an application convention. RCAB-E8.S9 (shared fare
--     readjustment policy) replaces this stand-in and will revise the trigger.
--   * quoted_fare_cents is LEGACY: no longer written; backfilled into
--     agreed_fare_cents below and kept for history.

ALTER TABLE pool_member
  ADD COLUMN IF NOT EXISTS agreed_fare_cents integer;

UPDATE pool_member
   SET agreed_fare_cents = quoted_fare_cents
 WHERE agreed_fare_cents IS NULL
   AND quoted_fare_cents IS NOT NULL;

ALTER TABLE pool_member
  DROP CONSTRAINT IF EXISTS pool_member_agreed_fare_check;
ALTER TABLE pool_member
  ADD CONSTRAINT pool_member_agreed_fare_check
  CHECK (agreed_fare_cents IS NULL OR agreed_fare_cents >= 0);

CREATE OR REPLACE FUNCTION pool_member_agreed_fare_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.agreed_fare_cents IS NULL THEN
      RAISE EXCEPTION 'pool_member (%, %) requires an agreed fare', NEW.pool_id, NEW.passenger_id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'pool_member_agreed_fare_required',
              TABLE = 'pool_member';
    END IF;
  ELSIF OLD.agreed_fare_cents IS NOT NULL
        AND NEW.agreed_fare_cents IS DISTINCT FROM OLD.agreed_fare_cents THEN
    RAISE EXCEPTION 'pool_member (%, %) agreed fare is fixed at join', OLD.pool_id, OLD.passenger_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'pool_member_agreed_fare_immutable',
            TABLE = 'pool_member';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pool_member_agreed_fare_guard_trg ON pool_member;
CREATE TRIGGER pool_member_agreed_fare_guard_trg
  BEFORE INSERT OR UPDATE ON pool_member
  FOR EACH ROW EXECUTE FUNCTION pool_member_agreed_fare_guard();
