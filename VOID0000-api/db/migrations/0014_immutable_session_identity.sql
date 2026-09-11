-- Legacy tokens have no session identity and must authenticate again. Never
-- adopt an old token into a newly issued login session.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS session_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_session_id_idx
  ON refresh_tokens (session_id) WHERE session_id IS NOT NULL;
