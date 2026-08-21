-- Online now follows live online/idle activity, replacing the separate
-- automatic presence preference.

UPDATE user_preferences
SET presence_mode = 'online'
WHERE presence_mode = 'auto';

ALTER TABLE user_preferences
  ALTER COLUMN presence_mode SET DEFAULT 'online';

ALTER TABLE user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_presence_mode_check;

ALTER TABLE user_preferences
  ADD CONSTRAINT user_preferences_presence_mode_check
  CHECK (presence_mode = ANY (ARRAY['online', 'idle', 'dnd', 'invisible']));
