-- RCAB-E8.S15 -- Google-only sign-in until launch (owner 2026-11-10, ADR-0003
-- amendment). A Google-registered account has a google_sub and a verified
-- email but no phone and no Firebase uid, so:
--
--   * app_user.phone_e164   becomes nullable (still UNIQUE; NULLs never clash).
--   * app_user.firebase_uid becomes nullable for the same reason (still UNIQUE).
--     The pre-launch OTP provider may not be Firebase, so it is not required
--     for phone accounts either.
--   * every account keeps at least one login identity:
--     CHECK (phone_e164 IS NOT NULL OR google_sub IS NOT NULL).
--   * google_sub is UNIQUE (0001 already declares it; asserted here so the
--     sign-in's ON CONFLICT (google_sub) always has an arbiter) and email exists.
--
-- Additive and backward compatible: every existing row has a phone, so the
-- CHECK validates immediately. Rollback = re-add NOT NULL only once no
-- Google-only rows exist.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS google_sub text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS email text;

ALTER TABLE app_user ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE app_user ALTER COLUMN firebase_uid DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = 'app_user'::regclass
       AND i.indisunique
       AND i.indnkeyatts = 1
       AND i.indpred IS NULL
       AND a.attname = 'google_sub'
  ) THEN
    CREATE UNIQUE INDEX app_user_google_sub_key ON app_user (google_sub);
  END IF;
END;
$$;

ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_identity_check;
ALTER TABLE app_user
  ADD CONSTRAINT app_user_identity_check
  CHECK (phone_e164 IS NOT NULL OR google_sub IS NOT NULL);
