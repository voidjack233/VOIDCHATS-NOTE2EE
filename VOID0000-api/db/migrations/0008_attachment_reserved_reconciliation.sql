-- Support bounded scans of expired attachment reservations.

CREATE INDEX IF NOT EXISTS idx_attachment_objects_reserved_reconciliation
  ON attachment_objects (reserved_until, conversation_id, message_id)
  WHERE status = 'reserved';
