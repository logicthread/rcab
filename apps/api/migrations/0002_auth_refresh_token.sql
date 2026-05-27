-- Auth refresh tokens: opaque UUID-v4, 30-day TTL, single-use (rotation on refresh)
CREATE TABLE IF NOT EXISTS auth_refresh_token (
  token       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_refresh_token_user_idx ON auth_refresh_token (user_id);
