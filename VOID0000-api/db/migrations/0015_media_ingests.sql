-- Video processing is separate from the staged/reserved/committed attachment
-- lifecycle. No source object is an attachment and no historical row is trusted.
CREATE TABLE media_ingests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploader_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'uploading',
  quarantine_object_key TEXT NOT NULL UNIQUE,
  filename VARCHAR(180) NOT NULL,
  source_bytes BIGINT,
  reserved_bytes BIGINT NOT NULL DEFAULT 10485760,
  final_attachment_id UUID UNIQUE REFERENCES attachment_objects(id) ON DELETE SET NULL,
  error_code VARCHAR(80),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  last_enqueued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  processing_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  quarantine_cleaned_at TIMESTAMPTZ,
  CONSTRAINT media_ingests_status_check CHECK (
    status IN ('uploading', 'queued', 'probing', 'processing', 'finalizing', 'ready', 'failed', 'cancelled')
  ),
  CONSTRAINT media_ingests_source_bytes_check CHECK (source_bytes IS NULL OR source_bytes BETWEEN 1 AND 10485760),
  CONSTRAINT media_ingests_reserved_bytes_check CHECK (reserved_bytes BETWEEN 1 AND 10485760),
  CONSTRAINT media_ingests_source_reservation_check CHECK (source_bytes IS NULL OR source_bytes <= reserved_bytes),
  CONSTRAINT media_ingests_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT media_ingests_quarantine_key_check CHECK (quarantine_object_key = 'video/' || id::text || '/source'),
  CONSTRAINT media_ingests_lease_check CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CONSTRAINT media_ingests_active_lease_check CHECK (
    status NOT IN ('probing', 'processing', 'finalizing') OR lease_token IS NOT NULL
  ),
  CONSTRAINT media_ingests_source_required_check CHECK (
    status NOT IN ('queued', 'probing', 'processing', 'finalizing', 'ready') OR source_bytes IS NOT NULL
  ),
  CONSTRAINT media_ingests_completion_check CHECK (
    (status IN ('ready', 'failed', 'cancelled')) = (completed_at IS NOT NULL)
  )
);

CREATE INDEX media_ingests_recovery ON media_ingests (updated_at, id)
  WHERE status IN ('queued', 'probing', 'processing', 'finalizing');
CREATE INDEX media_ingests_expiry ON media_ingests (expires_at, id)
  WHERE status = 'uploading';
CREATE INDEX media_ingests_quota ON media_ingests (uploader_id)
  INCLUDE (reserved_bytes)
  WHERE status IN ('uploading', 'queued', 'probing', 'processing', 'finalizing');
CREATE INDEX media_ingests_quarantine_cleanup ON media_ingests (completed_at, id)
  WHERE status IN ('ready', 'failed', 'cancelled') AND quarantine_cleaned_at IS NULL;
