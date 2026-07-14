-- Private object lookup for server-managed chat attachments.
-- Message rows hold display metadata while this table enforces object ownership.

CREATE TABLE IF NOT EXISTS attachment_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachment_objects_conversation
  ON attachment_objects (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attachment_objects_uploader
  ON attachment_objects (uploader_id, created_at DESC);
