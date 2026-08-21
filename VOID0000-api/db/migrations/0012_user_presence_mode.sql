-- Persist the account-wide public presence preference independently from
-- per-socket online/idle activity.

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS presence_mode VARCHAR NOT NULL DEFAULT 'auto';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_preferences_presence_mode_check'
  ) THEN
    ALTER TABLE user_preferences
      ADD CONSTRAINT user_preferences_presence_mode_check
      CHECK (presence_mode = ANY (ARRAY['auto', 'online', 'idle', 'dnd', 'invisible']));
  END IF;
END $$;
