-- In-app feedback + support chat (web "Give feedback" / "Contact help", driver app too).
--
-- feedback        one row per submitted form; write-only from the apps, read by staff.
-- support_message one conversation per user (the thread IS the user's rows, oldest first).
--                 sender = 'user' for the app, 'support' for staff / the auto-acknowledgement.
-- Staff replies are inserted directly (no admin UI yet): INSERT ... sender = 'support'.

CREATE TABLE IF NOT EXISTS feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('client','driver')),
  category    text NOT NULL CHECK (category IN ('bug','idea','compliment','other')),
  message     text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_user_idx ON feedback (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS support_message (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  sender      text NOT NULL CHECK (sender IN ('user','support')),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_message_user_idx ON support_message (user_id, created_at);
