ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS previous_token_hash VARCHAR,
  ADD COLUMN IF NOT EXISTS previous_jti UUID,
  ADD COLUMN IF NOT EXISTS previous_valid_until TIMESTAMP;

ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_previous_identity_complete
  CHECK (
    (
      previous_token_hash IS NULL
      AND previous_jti IS NULL
      AND previous_valid_until IS NULL
    )
    OR
    (
      previous_token_hash IS NOT NULL
      AND previous_jti IS NOT NULL
      AND previous_valid_until IS NOT NULL
    )
  );
