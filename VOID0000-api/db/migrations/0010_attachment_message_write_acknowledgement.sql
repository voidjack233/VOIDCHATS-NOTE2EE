-- Record only Scylla message writes that returned a LOCAL_QUORUM acknowledgement.
-- Existing reservations are deliberately left unacknowledged and uncertain.

ALTER TABLE attachment_objects
  ADD COLUMN IF NOT EXISTS scylla_write_acknowledged_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'attachment_objects_scylla_write_acknowledgement_check'
      AND conrelid = 'attachment_objects'::regclass
  ) THEN
    ALTER TABLE attachment_objects
      ADD CONSTRAINT attachment_objects_scylla_write_acknowledgement_check
      CHECK (
        scylla_write_acknowledged_at IS NULL
        OR scylla_write_policy = 'local_quorum_v1'
      );
  END IF;
END
$$;
