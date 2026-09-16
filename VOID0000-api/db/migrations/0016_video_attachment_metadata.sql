-- Video and poster remain ordinary content-addressed blobs; a poster is owned
-- by its logical video attachment, never by an independently shareable URL.
ALTER TABLE attachment_objects
  ADD COLUMN video_metadata JSONB,
  ADD COLUMN poster_blob_id UUID REFERENCES attachment_blobs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT attachment_video_metadata_check CHECK (
    (video_metadata IS NULL AND poster_blob_id IS NULL) OR
    (video_metadata IS NOT NULL AND poster_blob_id IS NOT NULL AND
     jsonb_typeof(video_metadata) = 'object' AND (video_metadata->>'mime' = 'video/mp4') IS TRUE)
  );
CREATE INDEX attachment_objects_poster_blob ON attachment_objects(poster_blob_id) WHERE poster_blob_id IS NOT NULL;

CREATE FUNCTION maintain_attachment_poster_blob() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE new_id UUID; old_id UUID; blob_status TEXT;
BEGIN
  IF TG_OP <> 'DELETE' THEN new_id := NEW.poster_blob_id; END IF;
  IF TG_OP <> 'INSERT' THEN old_id := OLD.poster_blob_id; END IF;
  IF new_id IS NOT DISTINCT FROM old_id THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF new_id IS NOT NULL THEN
    SELECT status INTO blob_status FROM attachment_blobs WHERE id = new_id FOR UPDATE;
    IF blob_status IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'Poster blob unavailable'; END IF;
    UPDATE attachment_blobs SET ref_count=ref_count+1,orphaned_at=NULL,updated_at=NOW() WHERE id=new_id;
  END IF;
  IF old_id IS NOT NULL THEN
    UPDATE attachment_blobs SET ref_count=GREATEST(ref_count-1,0),
      orphaned_at=CASE WHEN ref_count<=1 THEN COALESCE(orphaned_at,NOW()) ELSE orphaned_at END,
      updated_at=NOW() WHERE id=old_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER attachment_poster_blob_reference BEFORE INSERT OR UPDATE OF poster_blob_id OR DELETE
  ON attachment_objects FOR EACH ROW EXECUTE FUNCTION maintain_attachment_poster_blob();
