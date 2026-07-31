-- Identify reservations created by the explicit LOCAL_QUORUM message-write flow.
-- Historical reservations remain NULL and are never released after a negative read.

ALTER TABLE attachment_objects
  ADD COLUMN IF NOT EXISTS scylla_write_policy TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'attachment_objects_scylla_write_policy_check'
      AND conrelid = 'attachment_objects'::regclass
  ) THEN
    ALTER TABLE attachment_objects
      ADD CONSTRAINT attachment_objects_scylla_write_policy_check
      CHECK (
        scylla_write_policy IS NULL
        OR scylla_write_policy = 'local_quorum_v1'
      );
  END IF;
END
$$;
