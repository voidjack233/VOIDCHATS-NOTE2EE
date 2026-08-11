export const ATTACHMENT_BLOB_SCHEMA_MIGRATION =
  '0011_attachment_blob_deduplication.sql';

const ATTACHMENT_BLOB_SCHEMA_QUERY = `
SELECT
  to_regclass('attachment_blobs') IS NOT NULL AS has_blob_table,
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'attachment_objects'
      AND column_name = 'blob_id'
      AND data_type = 'uuid'
      AND is_nullable = 'NO'
  ) AS has_required_blob_id,
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = to_regclass('attachment_objects')
      AND confrelid = to_regclass('attachment_blobs')
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE
        'FOREIGN KEY (blob_id) REFERENCES attachment_blobs(id)%'
  ) AS has_blob_foreign_key
`;

const ATTACHMENT_BLOB_MIGRATION_QUERY = `
SELECT EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE filename = $1
) AS migration_applied
`;

function incompatibleSchemaError(serviceName, missing) {
  const error = new Error(
    `${serviceName} cannot start because the attachment blob schema is incompatible ` +
    `(missing: ${missing.join(', ')}). Migration ${ATTACHMENT_BLOB_SCHEMA_MIGRATION} ` +
    'is a no-mixed-version boundary: stop old message-service instances and attachment ' +
    'cleanup workers, run migrations, then start the new message service, worker, and VMD ' +
    'processes.',
  );
  error.code = 'ATTACHMENT_SCHEMA_INCOMPATIBLE';
  return error;
}

export async function assertAttachmentBlobSchemaCompatible({
  dbPool,
  serviceName = 'Attachment service',
} = {}) {
  if (!dbPool || typeof dbPool.query !== 'function') {
    throw new TypeError('Attachment schema compatibility requires a PostgreSQL pool');
  }

  let schemaResult;
  let migrationResult;
  try {
    schemaResult = await dbPool.query(ATTACHMENT_BLOB_SCHEMA_QUERY);
    migrationResult = await dbPool.query(
      ATTACHMENT_BLOB_MIGRATION_QUERY,
      [ATTACHMENT_BLOB_SCHEMA_MIGRATION],
    );
  } catch (cause) {
    const error = incompatibleSchemaError(serviceName, ['schema verification']);
    error.cause = cause;
    throw error;
  }

  const schema = schemaResult.rows[0] || {};
  const migration = migrationResult.rows[0] || {};
  const missing = [];
  if (schema.has_blob_table !== true) missing.push('attachment_blobs');
  if (schema.has_required_blob_id !== true) {
    missing.push('attachment_objects.blob_id UUID NOT NULL');
  }
  if (schema.has_blob_foreign_key !== true) missing.push('attachment blob foreign key');
  if (migration.migration_applied !== true) {
    missing.push(`migration record ${ATTACHMENT_BLOB_SCHEMA_MIGRATION}`);
  }

  if (missing.length > 0) {
    throw incompatibleSchemaError(serviceName, missing);
  }

  return Object.freeze({
    compatible: true,
    migration: ATTACHMENT_BLOB_SCHEMA_MIGRATION,
  });
}
