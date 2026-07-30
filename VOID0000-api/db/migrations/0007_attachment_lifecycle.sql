-- Staged attachment lifecycle for uploads that are not yet bound to a message.
-- Existing rows are deliberately classified as legacy because historical sent
-- attachments cannot be distinguished safely from abandoned uploads.

ALTER TABLE attachment_objects
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS staged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reservation_id TEXT,
  ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS message_id UUID;

UPDATE attachment_objects
SET status = 'legacy'
WHERE status IS NULL;

ALTER TABLE attachment_objects
  ALTER COLUMN status SET DEFAULT 'legacy',
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'attachment_objects_status_check'
      AND conrelid = 'attachment_objects'::regclass
  ) THEN
    ALTER TABLE attachment_objects
      ADD CONSTRAINT attachment_objects_status_check
      CHECK (status IN ('staged', 'reserved', 'committed', 'legacy'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'attachment_objects_size_bytes_check'
      AND conrelid = 'attachment_objects'::regclass
  ) THEN
    ALTER TABLE attachment_objects
      ADD CONSTRAINT attachment_objects_size_bytes_check
      CHECK (size_bytes IS NULL OR size_bytes >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'attachment_objects_lifecycle_fields_check'
      AND conrelid = 'attachment_objects'::regclass
  ) THEN
    ALTER TABLE attachment_objects
      ADD CONSTRAINT attachment_objects_lifecycle_fields_check
      CHECK (
        status = 'legacy'
        OR (
          size_bytes IS NOT NULL
          AND staged_at IS NOT NULL
          AND expires_at IS NOT NULL
          AND (
            status = 'staged'
            OR (
              reservation_id IS NOT NULL
              AND reserved_at IS NOT NULL
              AND message_id IS NOT NULL
              AND (
                (status = 'reserved' AND reserved_until IS NOT NULL)
                OR (status = 'committed' AND committed_at IS NOT NULL)
              )
            )
          )
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_attachment_objects_staged_cleanup
  ON attachment_objects (expires_at, id)
  WHERE status = 'staged';

CREATE INDEX IF NOT EXISTS idx_attachment_objects_staged_uploader
  ON attachment_objects (uploader_id, expires_at)
  INCLUDE (size_bytes)
  WHERE status = 'staged';

CREATE INDEX IF NOT EXISTS idx_attachment_objects_reservation
  ON attachment_objects (uploader_id, conversation_id, reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attachment_objects_message
  ON attachment_objects (message_id)
  WHERE message_id IS NOT NULL;
