-- RCAB-E8.S7 (review F12) — refresh tokens are stored hashed, grouped into
-- session families, and remember how the session was authenticated.
--
-- * token_hash  — SHA-256 hex digest of the opaque refresh token. The raw token
--                 is never persisted; a DB read no longer yields a credential.
-- * family_id   — shared by every rotation of one login. Presenting an
--                 already-consumed token revokes the whole family (replay).
-- * auth_method — 'phone' | 'google', so refresh keeps the original method.
--
-- Existing rows: their UUID-v4 tokens are hashed in place (each row becomes its
-- own family, auth_method 'phone') and the plaintext column is dropped in the
-- same transaction. Live sessions survive the deploy; no plaintext remains.
-- New tokens are 256-bit random base64url strings.

ALTER TABLE auth_refresh_token
  ADD COLUMN IF NOT EXISTS token_hash text,
  ADD COLUMN IF NOT EXISTS family_id uuid,
  ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'phone';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'auth_refresh_token' AND column_name = 'token'
  ) THEN
    UPDATE auth_refresh_token
       SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'),
           family_id  = gen_random_uuid()
     WHERE token_hash IS NULL;
    -- Dropping the column also drops the old PRIMARY KEY (token).
    ALTER TABLE auth_refresh_token DROP COLUMN token;
  END IF;
END $$;

ALTER TABLE auth_refresh_token
  ALTER COLUMN token_hash SET NOT NULL,
  ALTER COLUMN family_id SET NOT NULL;

ALTER TABLE auth_refresh_token
  DROP CONSTRAINT IF EXISTS auth_refresh_token_pkey;
ALTER TABLE auth_refresh_token
  ADD CONSTRAINT auth_refresh_token_pkey PRIMARY KEY (token_hash);

ALTER TABLE auth_refresh_token
  DROP CONSTRAINT IF EXISTS auth_refresh_token_hash_check;
ALTER TABLE auth_refresh_token
  ADD CONSTRAINT auth_refresh_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE auth_refresh_token
  DROP CONSTRAINT IF EXISTS auth_refresh_token_auth_method_check;
ALTER TABLE auth_refresh_token
  ADD CONSTRAINT auth_refresh_token_auth_method_check CHECK (auth_method IN ('phone', 'google'));

CREATE INDEX IF NOT EXISTS auth_refresh_token_family_idx ON auth_refresh_token (family_id);
