-- Claim before Scylla; complete in the same transaction as unread updates.
-- No TTL: expiry must never silently turn an old retry into another message.
CREATE TABLE message_send_operations (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL CHECK (length(client_message_id) BETWEEN 1 AND 128),
  -- Keep the claim if a group's storage channel is removed/replaced. A retry
  -- must reject a changed storage identity, not silently become another send.
  storage_conversation_id UUID NOT NULL,
  message_id UUID NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  effects_scheduled_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, conversation_id, client_message_id),
  CHECK (effects_scheduled_at IS NULL OR completed_at IS NOT NULL)
);
