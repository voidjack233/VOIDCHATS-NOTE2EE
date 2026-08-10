-- Separate logical attachment authorization/lifecycle from physical MinIO blobs.
-- Historical objects are backfilled one-to-one without an invented content hash.

CREATE TABLE attachment_blobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_hash TEXT,
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes BIGINT,
  content_type TEXT,
  inline BOOLEAN,
  status TEXT NOT NULL DEFAULT 'ready',
  ref_count BIGINT NOT NULL DEFAULT 0,
  orphaned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attachment_blobs_content_hash_check
    CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT attachment_blobs_size_bytes_check
    CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT attachment_blobs_status_check
    CHECK (status IN ('ready', 'deleting')),
  CONSTRAINT attachment_blobs_ref_count_check
    CHECK (ref_count >= 0),
  CONSTRAINT attachment_blobs_bucket_object_key_key
    UNIQUE (bucket, object_key)
);

CREATE UNIQUE INDEX attachment_blobs_content_hash_unique
  ON attachment_blobs (content_hash)
  WHERE content_hash IS NOT NULL;

ALTER TABLE attachment_objects
  ADD COLUMN blob_id UUID,
  ADD COLUMN filename VARCHAR(180);

INSERT INTO attachment_blobs (
  content_hash,
  bucket,
  object_key,
  size_bytes,
  status,
  ref_count,
  created_at,
  updated_at
)
SELECT
  NULL,
  attachment.bucket,
  attachment.object_key,
  attachment.size_bytes,
  'ready',
  1,
  attachment.created_at,
  NOW()
FROM attachment_objects AS attachment
ON CONFLICT (bucket, object_key) DO NOTHING;

UPDATE attachment_objects AS attachment
SET blob_id = blob.id
FROM attachment_blobs AS blob
WHERE attachment.blob_id IS NULL
  AND blob.bucket = attachment.bucket
  AND blob.object_key = attachment.object_key;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM attachment_objects
    WHERE blob_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot backfill every attachment object to a physical blob';
  END IF;
END
$$;

ALTER TABLE attachment_objects
  ALTER COLUMN blob_id SET NOT NULL,
  ADD CONSTRAINT attachment_objects_blob_id_fkey
    FOREIGN KEY (blob_id) REFERENCES attachment_blobs(id) ON DELETE RESTRICT;

ALTER TABLE attachment_objects
  DROP CONSTRAINT IF EXISTS attachment_objects_object_key_key;

CREATE INDEX idx_attachment_objects_blob
  ON attachment_objects (blob_id);

CREATE INDEX idx_attachment_blobs_orphan_cleanup
  ON attachment_blobs (orphaned_at, id)
  WHERE ref_count = 0;

CREATE OR REPLACE FUNCTION require_ready_attachment_blob()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  blob_status TEXT;
BEGIN
  SELECT status
  INTO blob_status
  FROM attachment_blobs
  WHERE id = NEW.blob_id
  FOR KEY SHARE;

  IF blob_status IS NULL THEN
    RAISE EXCEPTION 'Attachment blob % does not exist', NEW.blob_id;
  END IF;
  IF blob_status <> 'ready' THEN
    RAISE EXCEPTION 'Attachment blob % is not available', NEW.blob_id;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION maintain_attachment_blob_ref_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE attachment_blobs
    SET ref_count = ref_count + 1,
        orphaned_at = NULL,
        updated_at = NOW()
    WHERE id = NEW.blob_id;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    UPDATE attachment_blobs
    SET ref_count = GREATEST(ref_count - 1, 0),
        orphaned_at = CASE
          WHEN ref_count <= 1 THEN COALESCE(orphaned_at, NOW())
          ELSE orphaned_at
        END,
        updated_at = NOW()
    WHERE id = OLD.blob_id;
    RETURN OLD;
  END IF;

  IF NEW.blob_id IS DISTINCT FROM OLD.blob_id THEN
    UPDATE attachment_blobs
    SET ref_count = GREATEST(ref_count - 1, 0),
        orphaned_at = CASE
          WHEN ref_count <= 1 THEN COALESCE(orphaned_at, NOW())
          ELSE orphaned_at
        END,
        updated_at = NOW()
    WHERE id = OLD.blob_id;

    UPDATE attachment_blobs
    SET ref_count = ref_count + 1,
        orphaned_at = NULL,
        updated_at = NOW()
    WHERE id = NEW.blob_id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER attachment_objects_require_ready_blob
BEFORE INSERT OR UPDATE OF blob_id ON attachment_objects
FOR EACH ROW
EXECUTE FUNCTION require_ready_attachment_blob();

CREATE TRIGGER attachment_objects_maintain_blob_ref_count
AFTER INSERT OR DELETE OR UPDATE OF blob_id ON attachment_objects
FOR EACH ROW
EXECUTE FUNCTION maintain_attachment_blob_ref_count();

-- Recompute after backfill so the cached count starts from actual references.
UPDATE attachment_blobs AS blob
SET ref_count = reference.actual_count,
    orphaned_at = CASE
      WHEN reference.actual_count = 0 THEN COALESCE(blob.orphaned_at, NOW())
      ELSE NULL
    END,
    updated_at = NOW()
FROM (
  SELECT attachment_blobs.id,
         COUNT(attachment_objects.id)::bigint AS actual_count
  FROM attachment_blobs
  LEFT JOIN attachment_objects
    ON attachment_objects.blob_id = attachment_blobs.id
  GROUP BY attachment_blobs.id
) AS reference
WHERE blob.id = reference.id;
