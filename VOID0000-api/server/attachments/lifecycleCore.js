import { createHash, randomUUID } from 'node:crypto';

import { ATTACHMENT_MESSAGE_WRITE_POLICY } from './messageConsistency.js';

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PROTECTED_ATTACHMENT_PATH_PATTERN = new RegExp(
  `^/api/conversations/[^/?#]+/attachments/(${UUID_SOURCE})/?$`,
  'i',
);

export const DEFAULT_STAGED_ATTACHMENT_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_ATTACHMENT_RESERVATION_TTL_SECONDS = 5 * 60;
export const DEFAULT_STAGED_ATTACHMENT_MAX_COUNT = 25;
export const DEFAULT_STAGED_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_SECONDS = 15 * 60;
export const DEFAULT_ATTACHMENT_CLEANUP_BATCH_SIZE = 50;
export const DEFAULT_ATTACHMENT_RECONCILIATION_BATCH_SIZE = 25;
export const DEFAULT_ATTACHMENT_BLOB_GC_GRACE_SECONDS = 24 * 60 * 60;
export const DEFAULT_ATTACHMENT_BLOB_GC_BATCH_SIZE = 25;

const MAX_STAGED_ATTACHMENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_ATTACHMENT_RESERVATION_TTL_SECONDS = 60 * 60;
const MAX_STAGED_ATTACHMENT_MAX_COUNT = 500;
const MAX_STAGED_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_ATTACHMENT_CLEANUP_INTERVAL_SECONDS = 24 * 60 * 60;
const MAX_ATTACHMENT_CLEANUP_BATCH_SIZE = 500;
const MAX_ATTACHMENT_RECONCILIATION_BATCH_SIZE = 100;
const MAX_ATTACHMENT_BLOB_GC_GRACE_SECONDS = 30 * 24 * 60 * 60;
const MAX_ATTACHMENT_BLOB_GC_BATCH_SIZE = 100;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

function resolvePositiveInteger(value, fallback, maximum) {
  const normalized = value == null ? '' : String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    return fallback;
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    return fallback;
  }
  return parsed;
}

export function resolveAttachmentLifecycleConfig(env = process.env) {
  return Object.freeze({
    stagedTtlSeconds: resolvePositiveInteger(
      env.ATTACHMENT_STAGED_TTL_SECONDS,
      DEFAULT_STAGED_ATTACHMENT_TTL_SECONDS,
      MAX_STAGED_ATTACHMENT_TTL_SECONDS,
    ),
    reservationTtlSeconds: resolvePositiveInteger(
      env.ATTACHMENT_RESERVATION_TTL_SECONDS,
      DEFAULT_ATTACHMENT_RESERVATION_TTL_SECONDS,
      MAX_ATTACHMENT_RESERVATION_TTL_SECONDS,
    ),
    stagedMaxCount: resolvePositiveInteger(
      env.ATTACHMENT_STAGED_MAX_COUNT,
      DEFAULT_STAGED_ATTACHMENT_MAX_COUNT,
      MAX_STAGED_ATTACHMENT_MAX_COUNT,
    ),
    stagedMaxBytes: resolvePositiveInteger(
      env.ATTACHMENT_STAGED_MAX_BYTES,
      DEFAULT_STAGED_ATTACHMENT_MAX_BYTES,
      MAX_STAGED_ATTACHMENT_MAX_BYTES,
    ),
    cleanupIntervalSeconds: resolvePositiveInteger(
      env.ATTACHMENT_CLEANUP_INTERVAL_SECONDS,
      DEFAULT_ATTACHMENT_CLEANUP_INTERVAL_SECONDS,
      MAX_ATTACHMENT_CLEANUP_INTERVAL_SECONDS,
    ),
    cleanupBatchSize: resolvePositiveInteger(
      env.ATTACHMENT_CLEANUP_BATCH_SIZE,
      DEFAULT_ATTACHMENT_CLEANUP_BATCH_SIZE,
      MAX_ATTACHMENT_CLEANUP_BATCH_SIZE,
    ),
    reconciliationBatchSize: resolvePositiveInteger(
      env.ATTACHMENT_RESERVATION_RECONCILIATION_BATCH_SIZE,
      DEFAULT_ATTACHMENT_RECONCILIATION_BATCH_SIZE,
      MAX_ATTACHMENT_RECONCILIATION_BATCH_SIZE,
    ),
    blobGcGraceSeconds: resolvePositiveInteger(
      env.ATTACHMENT_BLOB_GC_GRACE_SECONDS,
      DEFAULT_ATTACHMENT_BLOB_GC_GRACE_SECONDS,
      MAX_ATTACHMENT_BLOB_GC_GRACE_SECONDS,
    ),
    blobGcBatchSize: resolvePositiveInteger(
      env.ATTACHMENT_BLOB_GC_BATCH_SIZE,
      DEFAULT_ATTACHMENT_BLOB_GC_BATCH_SIZE,
      MAX_ATTACHMENT_BLOB_GC_BATCH_SIZE,
    ),
  });
}

export function createAttachmentContentHash(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError('Attachment blob hashing requires a non-empty buffer');
  }
  return createHash('sha256').update(buffer).digest('hex');
}

export function createAttachmentBlobObjectKey(contentHash) {
  const normalized = String(contentHash || '').trim().toLowerCase();
  if (!CONTENT_HASH_PATTERN.test(normalized)) {
    throw new TypeError('Attachment blob object key requires a SHA-256 hash');
  }
  return `blobs/v1/sha256/${normalized.slice(0, 2)}/${normalized}`;
}

export class AttachmentLifecycleError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'AttachmentLifecycleError';
    this.status = status;
    this.code = code;
    this.body = {
      error: message,
      code,
      ...extra,
    };
  }
}

function fail(status, code, message, extra) {
  throw new AttachmentLifecycleError(status, code, message, extra);
}

function parseAttachmentDescriptor(rawAttachment) {
  if (typeof rawAttachment !== 'string' || !rawAttachment.trim()) {
    fail(400, 'ATTACHMENT_REFERENCE_INVALID', 'Each attachment must be a private upload reference');
  }

  const raw = rawAttachment.trim();
  let descriptor = { url: raw };

  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(400, 'ATTACHMENT_REFERENCE_INVALID', 'Attachment descriptor must be an object');
      }
      descriptor = parsed;
    } catch (error) {
      if (error instanceof AttachmentLifecycleError) {
        throw error;
      }
      fail(400, 'ATTACHMENT_REFERENCE_INVALID', 'Attachment descriptor is malformed');
    }
  }

  const stableUrl = typeof descriptor.fallback_url === 'string' && descriptor.fallback_url.trim()
    ? descriptor.fallback_url.trim()
    : typeof descriptor.url === 'string'
      ? descriptor.url.trim()
      : '';

  if (!stableUrl.startsWith('/api/')) {
    fail(400, 'ATTACHMENT_REFERENCE_EXTERNAL', 'External attachment references are not accepted');
  }

  const match = stableUrl.match(PROTECTED_ATTACHMENT_PATH_PATTERN);
  if (!match?.[1]) {
    fail(400, 'ATTACHMENT_REFERENCE_INVALID', 'Attachment reference is not a protected upload');
  }

  return {
    id: match[1].toLowerCase(),
    stableUrl,
  };
}

export function extractProtectedAttachmentIds(rawAttachments) {
  if (!Array.isArray(rawAttachments)) {
    fail(400, 'ATTACHMENTS_INVALID', 'attachments must be an array');
  }
  if (rawAttachments.length > 5) {
    fail(400, 'ATTACHMENT_LIMIT_EXCEEDED', 'attachments must contain at most 5 items');
  }

  const references = rawAttachments.map(parseAttachmentDescriptor);
  const seen = new Set();
  for (const reference of references) {
    if (seen.has(reference.id)) {
      fail(400, 'ATTACHMENT_DUPLICATE', 'The same attachment cannot be used more than once');
    }
    seen.add(reference.id);
  }
  return references.map((reference) => reference.id);
}

export function assertStagedUploadQuota({
  currentCount,
  currentBytes,
  incomingCount,
  incomingBytes,
  maxCount,
  maxBytes,
}) {
  const nextCount = Number(currentCount || 0) + Number(incomingCount || 0);
  const nextBytes = Number(currentBytes || 0) + Number(incomingBytes || 0);

  if (nextCount > maxCount || nextBytes > maxBytes) {
    fail(
      429,
      'ATTACHMENT_STAGED_QUOTA_EXCEEDED',
      'Too many unsent attachments are waiting. Send or remove existing uploads before adding more.',
      {
        staged_count_limit: maxCount,
        staged_bytes_limit: maxBytes,
      },
    );
  }
}

function normalizeRowId(row) {
  return String(row.id || '').toLowerCase();
}

function assertExactRows(rows, attachmentIds) {
  const rowsById = new Map(rows.map((row) => [normalizeRowId(row), row]));
  if (rowsById.size !== attachmentIds.length) {
    fail(400, 'ATTACHMENT_NOT_FOUND', 'One or more attachments are unavailable');
  }
  return attachmentIds.map((attachmentId) => rowsById.get(attachmentId));
}

export function classifyAttachmentReservation({
  rows,
  attachmentIds,
  userId,
  conversationId,
  reservationId,
}) {
  const orderedRows = assertExactRows(rows, attachmentIds);

  for (const row of orderedRows) {
    if (
      String(row.uploader_id) !== String(userId) ||
      String(row.conversation_id) !== String(conversationId)
    ) {
      fail(403, 'ATTACHMENT_FORBIDDEN', 'Attachment does not belong to this sender and conversation');
    }
  }

  if (orderedRows.every((row) => row.status === 'staged')) {
    if (orderedRows.some((row) => Boolean(row.is_expired))) {
      fail(409, 'ATTACHMENT_EXPIRED', 'One or more attachments expired before the message was sent');
    }
    return { state: 'staged', messageId: null };
  }

  const isSameReservation = orderedRows.every((row) => (
    row.reservation_id === reservationId &&
    typeof row.message_id === 'string' &&
    row.message_id.length > 0
  ));
  const messageIds = new Set(orderedRows.map((row) => String(row.message_id || '')));
  if (!isSameReservation || messageIds.size !== 1) {
    fail(409, 'ATTACHMENT_ALREADY_USED', 'One or more attachments are already reserved or committed');
  }

  if (orderedRows.every((row) => row.status === 'committed')) {
    return { state: 'committed', messageId: orderedRows[0].message_id };
  }
  if (orderedRows.every((row) => row.status === 'reserved')) {
    return {
      state: 'reserved',
      messageId: orderedRows[0].message_id,
      reservationExpired: orderedRows.every((row) => Boolean(row.reservation_expired)),
    };
  }

  fail(409, 'ATTACHMENT_STATE_CONFLICT', 'Attachment lifecycle state is inconsistent');
}

async function withTransaction(dbPool, callback) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function readStagedUsage(queryable, userId) {
  const result = await queryable.query(
    `SELECT COUNT(*)::int AS staged_count,
            COALESCE(SUM(size_bytes), 0)::bigint AS staged_bytes
     FROM attachment_objects
     WHERE uploader_id = $1
       AND status = 'staged'`,
    [userId],
  );
  return {
    count: Number(result.rows[0]?.staged_count || 0),
    bytes: Number(result.rows[0]?.staged_bytes || 0),
  };
}

export function createAttachmentLifecycle({
  dbPool,
  objectStore,
  bucket,
  config = resolveAttachmentLifecycleConfig(),
  logger = console,
} = {}) {
  if (!dbPool || typeof dbPool.query !== 'function' || typeof dbPool.connect !== 'function') {
    throw new TypeError('Attachment lifecycle requires a PostgreSQL pool');
  }
  if (
    !objectStore ||
    typeof objectStore.putObject !== 'function' ||
    typeof objectStore.removeObject !== 'function'
  ) {
    throw new TypeError('Attachment lifecycle requires an object store');
  }
  if (typeof bucket !== 'string' || !bucket.trim()) {
    throw new TypeError('Attachment lifecycle requires a storage bucket');
  }

  async function assertUploadAllowed({ userId, incomingCount, incomingBytes }) {
    const usage = await readStagedUsage(dbPool, userId);
    assertStagedUploadQuota({
      currentCount: usage.count,
      currentBytes: usage.bytes,
      incomingCount,
      incomingBytes,
      maxCount: config.stagedMaxCount,
      maxBytes: config.stagedMaxBytes,
    });
  }

  async function stageUploadedAttachments({
    userId,
    conversationId,
    attachments,
  }) {
    const preparedAttachments = attachments.map((attachment) => {
      if (!Buffer.isBuffer(attachment.buffer) || attachment.buffer.length === 0) {
        throw new TypeError('Staged attachments require final non-empty bytes');
      }
      const contentHash = createAttachmentContentHash(attachment.buffer);
      return {
        ...attachment,
        contentHash,
        objectKey: createAttachmentBlobObjectKey(contentHash),
        sizeBytes: attachment.buffer.length,
      };
    });
    const incomingBytes = preparedAttachments.reduce(
      (total, attachment) => total + attachment.sizeBytes,
      0,
    );

    return withTransaction(dbPool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`attachment-staged-quota:${userId}`],
      );
      const usage = await readStagedUsage(client, userId);
      assertStagedUploadQuota({
        currentCount: usage.count,
        currentBytes: usage.bytes,
        incomingCount: preparedAttachments.length,
        incomingBytes,
        maxCount: config.stagedMaxCount,
        maxBytes: config.stagedMaxBytes,
      });

      const attachmentGroups = new Map();
      for (const attachment of preparedAttachments) {
        const group = attachmentGroups.get(attachment.contentHash) || [];
        group.push(attachment);
        attachmentGroups.set(attachment.contentHash, group);
      }

      const blobByHash = new Map();
      for (const contentHash of [...attachmentGroups.keys()].sort()) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`attachment-blob:${contentHash}`],
        );

        const [representative] = attachmentGroups.get(contentHash);
        const existingResult = await client.query(
          `SELECT id, bucket, object_key, size_bytes, content_type, inline, status
           FROM attachment_blobs
           WHERE content_hash = $1
           FOR UPDATE`,
          [contentHash],
        );
        const existing = existingResult.rows[0];

        if (existing) {
          if (existing.status !== 'ready') {
            fail(
              503,
              'ATTACHMENT_BLOB_BUSY',
              'This attachment is temporarily unavailable for upload',
              { retryable: true },
            );
          }
          if (
            existing.bucket !== bucket ||
            existing.object_key !== representative.objectKey ||
            Number(existing.size_bytes) !== representative.sizeBytes ||
            existing.content_type !== representative.contentType ||
            existing.inline !== representative.inline
          ) {
            fail(
              409,
              'ATTACHMENT_BLOB_CONFLICT',
              'Attachment content identity conflicts with stored metadata',
            );
          }
          blobByHash.set(contentHash, existing);
          continue;
        }

        await objectStore.putObject(
          bucket,
          representative.objectKey,
          representative.buffer,
          representative.sizeBytes,
          representative.objectMetadata,
        );
        const insertBlobResult = await client.query(
          `INSERT INTO attachment_blobs (
             content_hash,
             bucket,
             object_key,
             size_bytes,
             content_type,
             inline,
             status,
             ref_count,
             orphaned_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'ready', 0, NOW())
           RETURNING id, bucket, object_key, size_bytes, content_type, inline, status`,
          [
            contentHash,
            bucket,
            representative.objectKey,
            representative.sizeBytes,
            representative.contentType,
            representative.inline,
          ],
        );
        blobByHash.set(contentHash, insertBlobResult.rows[0]);
      }

      for (const attachment of preparedAttachments) {
        const blob = blobByHash.get(attachment.contentHash);
        await client.query(
          `INSERT INTO attachment_objects (
             id,
             conversation_id,
             uploader_id,
             bucket,
             object_key,
             blob_id,
             filename,
             status,
             size_bytes,
             staged_at,
             expires_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, 'staged', $8, NOW(),
             NOW() + ($9 * INTERVAL '1 second')
           )`,
          [
            attachment.id,
            conversationId,
            userId,
            blob.bucket,
            blob.object_key,
            blob.id,
            attachment.filename,
            attachment.sizeBytes,
            config.stagedTtlSeconds,
          ],
        );
      }

      return preparedAttachments.map((attachment) => ({
        id: attachment.id,
        blobId: blobByHash.get(attachment.contentHash).id,
        contentHash: attachment.contentHash,
        objectKey: attachment.objectKey,
      }));
    });
  }

  async function deleteStagedAttachment({ attachmentId, userId, conversationId }) {
    return withTransaction(dbPool, async (client) => {
      const result = await client.query(
        `SELECT id, conversation_id, uploader_id, status
         FROM attachment_objects
         WHERE id = $1
         FOR UPDATE`,
        [attachmentId],
      );
      const row = result.rows[0];
      if (!row) {
        return { deleted: false, reason: 'not_found' };
      }
      if (String(row.conversation_id) !== String(conversationId)) {
        fail(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');
      }
      if (String(row.uploader_id) !== String(userId)) {
        fail(403, 'ATTACHMENT_FORBIDDEN', 'Attachment belongs to another user');
      }
      if (row.status !== 'staged') {
        fail(409, 'ATTACHMENT_NOT_STAGED', 'Only unsent staged attachments can be removed');
      }

      const deleteResult = await client.query(
        `DELETE FROM attachment_objects
         WHERE id = $1
           AND status = 'staged'`,
        [attachmentId],
      );
      if (deleteResult.rowCount !== 1) {
        fail(409, 'ATTACHMENT_STATE_CONFLICT', 'Attachment changed while it was being removed');
      }
      return { deleted: true };
    });
  }

  async function reserveForMessage({
    attachmentIds,
    userId,
    conversationId,
    reservationId,
    messageId,
  }) {
    if (attachmentIds.length === 0) {
      return {
        state: 'none',
        attachmentIds: [],
        reservationId,
        messageId,
        userId,
        conversationId,
      };
    }

    return withTransaction(dbPool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`attachment-message:${userId}:${conversationId}:${reservationId}`],
      );

      const operationResult = await client.query(
        `SELECT id
         FROM attachment_objects
         WHERE uploader_id = $1
           AND conversation_id = $2
           AND reservation_id = $3
         FOR UPDATE`,
        [userId, conversationId, reservationId],
      );
      const existingOperationIds = operationResult.rows.map(normalizeRowId).sort();
      const requestedIds = [...attachmentIds].sort();
      if (
        existingOperationIds.length > 0 &&
        (
          existingOperationIds.length !== requestedIds.length ||
          existingOperationIds.some((id, index) => id !== requestedIds[index])
        )
      ) {
        fail(
          409,
          'CLIENT_MESSAGE_ATTACHMENT_MISMATCH',
          'This message operation was already used with a different attachment set',
        );
      }

      const result = await client.query(
        `SELECT id,
                conversation_id,
                uploader_id,
                status,
                reservation_id,
                message_id::text AS message_id,
                expires_at <= NOW() AS is_expired,
                reserved_until <= NOW() AS reservation_expired
         FROM attachment_objects
         WHERE id = ANY($1::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [attachmentIds],
      );
      const classification = classifyAttachmentReservation({
        rows: result.rows,
        attachmentIds,
        userId,
        conversationId,
        reservationId,
      });

      if (classification.state !== 'staged') {
        return {
          ...classification,
          attachmentIds,
          reservationId,
          userId,
          conversationId,
        };
      }

      const updateResult = await client.query(
        `UPDATE attachment_objects
         SET status = 'reserved',
             reserved_at = NOW(),
             reserved_until = NOW() + ($4 * INTERVAL '1 second'),
             reservation_id = $2,
             message_id = $3,
             scylla_write_policy = NULL,
             scylla_write_acknowledged_at = NULL
         WHERE id = ANY($1::uuid[])
           AND status = 'staged'
           AND expires_at > NOW()
         RETURNING id`,
        [
          attachmentIds,
          reservationId,
          messageId,
          config.reservationTtlSeconds,
        ],
      );
      if (updateResult.rowCount !== attachmentIds.length) {
        fail(409, 'ATTACHMENT_STATE_CONFLICT', 'Attachment changed while reserving it');
      }

      return {
        state: 'reserved_new',
        attachmentIds,
        reservationId,
        messageId,
        userId,
        conversationId,
      };
    });
  }

  async function acknowledgeScyllaWrite({
    attachmentIds,
    reservationId,
    messageId,
    userId,
    conversationId,
  }) {
    if (attachmentIds.length === 0) {
      return 0;
    }

    return withTransaction(dbPool, async (client) => {
      const lockedResult = await client.query(
        `SELECT id, scylla_write_policy, scylla_write_acknowledged_at
         FROM attachment_objects
         WHERE id = ANY($1::uuid[])
           AND status = 'reserved'
           AND reservation_id = $2
           AND message_id = $3
           AND uploader_id = $4
           AND conversation_id = $5
         ORDER BY id
         FOR UPDATE`,
        [
          attachmentIds,
          reservationId,
          messageId,
          userId,
          conversationId,
        ],
      );
      const lockedIds = lockedResult.rows.map(normalizeRowId).sort();
      const expectedIds = [...attachmentIds].sort();
      if (
        lockedIds.length !== expectedIds.length ||
        lockedIds.some((id, index) => id !== expectedIds[index])
      ) {
        fail(
          409,
          'ATTACHMENT_ACKNOWLEDGEMENT_CONFLICT',
          'Attachment reservation changed before its Scylla write was acknowledged',
        );
      }

      const alreadyAcknowledged = lockedResult.rows.every((row) => (
        row.scylla_write_policy === ATTACHMENT_MESSAGE_WRITE_POLICY &&
        row.scylla_write_acknowledged_at != null
      ));
      if (alreadyAcknowledged) {
        return attachmentIds.length;
      }
      if (lockedResult.rows.some((row) => (
        row.scylla_write_acknowledged_at != null ||
        (
          row.scylla_write_policy != null &&
          row.scylla_write_policy !== ATTACHMENT_MESSAGE_WRITE_POLICY
        )
      ))) {
        fail(
          409,
          'ATTACHMENT_ACKNOWLEDGEMENT_CONFLICT',
          'Attachment acknowledgement state is inconsistent',
        );
      }

      const updateResult = await client.query(
        `UPDATE attachment_objects
         SET scylla_write_policy = $6,
             scylla_write_acknowledged_at = NOW()
         WHERE id = ANY($1::uuid[])
           AND status = 'reserved'
           AND reservation_id = $2
           AND message_id = $3
           AND uploader_id = $4
           AND conversation_id = $5
           AND scylla_write_acknowledged_at IS NULL
           AND (
             scylla_write_policy IS NULL
             OR scylla_write_policy = $6
           )
         RETURNING id`,
        [
          attachmentIds,
          reservationId,
          messageId,
          userId,
          conversationId,
          ATTACHMENT_MESSAGE_WRITE_POLICY,
        ],
      );
      if (updateResult.rowCount !== attachmentIds.length) {
        fail(
          409,
          'ATTACHMENT_ACKNOWLEDGEMENT_CONFLICT',
          'Attachment reservation could not be acknowledged',
        );
      }
      return updateResult.rowCount;
    });
  }

  async function commitReservation(queryable, {
    attachmentIds,
    reservationId,
    messageId,
    userId,
    conversationId,
  }) {
    if (attachmentIds.length === 0) {
      return 0;
    }

    const result = await queryable.query(
      `UPDATE attachment_objects
       SET status = 'committed',
           committed_at = NOW(),
           reserved_until = NULL
       WHERE id = ANY($1::uuid[])
         AND status = 'reserved'
         AND reservation_id = $2
         AND message_id = $3
         AND uploader_id = $4
         AND conversation_id = $5
         AND scylla_write_policy = $6
         AND scylla_write_acknowledged_at IS NOT NULL
       RETURNING id`,
      [
        attachmentIds,
        reservationId,
        messageId,
        userId,
        conversationId,
        ATTACHMENT_MESSAGE_WRITE_POLICY,
      ],
    );
    if (result.rowCount !== attachmentIds.length) {
      fail(409, 'ATTACHMENT_COMMIT_CONFLICT', 'Attachment reservation could not be committed');
    }
    return result.rowCount;
  }

  async function releaseReservation({
    attachmentIds,
    reservationId,
    messageId,
    userId,
    conversationId,
  }) {
    if (attachmentIds.length === 0) {
      return 0;
    }

    const result = await dbPool.query(
      `UPDATE attachment_objects
       SET status = 'staged',
           reserved_at = NULL,
           reserved_until = NULL,
           reservation_id = NULL,
           message_id = NULL,
           scylla_write_policy = NULL,
           scylla_write_acknowledged_at = NULL
       WHERE id = ANY($1::uuid[])
         AND status = 'reserved'
         AND reservation_id = $2
         AND message_id = $3
         AND uploader_id = $4
         AND conversation_id = $5`,
      [
        attachmentIds,
        reservationId,
        messageId,
        userId,
        conversationId,
      ],
    );
    return result.rowCount;
  }

  async function cleanupExpiredStaged({ batchSize = config.cleanupBatchSize } = {}) {
    const candidateResult = await dbPool.query(
      `SELECT id
       FROM attachment_objects
       WHERE status = 'staged'
         AND expires_at <= NOW()
       ORDER BY expires_at, id
       LIMIT $1`,
      [batchSize],
    );
    const summary = {
      selected: candidateResult.rows.length,
      deleted: 0,
      failed: 0,
    };

    for (const candidate of candidateResult.rows) {
      try {
        const result = await withTransaction(dbPool, async (client) => {
          const lockedResult = await client.query(
            `SELECT id
             FROM attachment_objects
             WHERE id = $1
               AND status = 'staged'
               AND expires_at <= NOW()
             FOR UPDATE`,
            [candidate.id],
          );
          const row = lockedResult.rows[0];
          if (!row) {
            return false;
          }

          const deleteResult = await client.query(
            `DELETE FROM attachment_objects
             WHERE id = $1
               AND status = 'staged'`,
            [candidate.id],
          );
          return deleteResult.rowCount === 1;
        });
        if (result) {
          summary.deleted += 1;
        }
      } catch (error) {
        summary.failed += 1;
        logger.error('[ATTACHMENT_CLEANUP] staged attachment cleanup failed', {
          attachment_id: String(candidate.id),
          error: error instanceof Error ? error.message : String(error || ''),
        });
      }
    }

    return summary;
  }

  async function cleanupOrphanedBlobs({ batchSize = config.blobGcBatchSize } = {}) {
    const candidateResult = await dbPool.query(
      `SELECT id
       FROM attachment_blobs
       WHERE ref_count = 0
         AND orphaned_at <= NOW() - ($1 * INTERVAL '1 second')
         AND status IN ('ready', 'deleting')
       ORDER BY orphaned_at, id
       LIMIT $2`,
      [config.blobGcGraceSeconds, batchSize],
    );
    const summary = {
      selected: candidateResult.rows.length,
      deleted: 0,
      retained: 0,
      failed: 0,
    };

    for (const candidate of candidateResult.rows) {
      let blob;
      try {
        blob = await withTransaction(dbPool, async (client) => {
          const lockedResult = await client.query(
            `SELECT id, bucket, object_key, status, ref_count, orphaned_at
             FROM attachment_blobs
             WHERE id = $1
               AND ref_count = 0
               AND orphaned_at <= NOW() - ($2 * INTERVAL '1 second')
               AND status IN ('ready', 'deleting')
             FOR UPDATE`,
            [candidate.id, config.blobGcGraceSeconds],
          );
          const row = lockedResult.rows[0];
          if (!row) return null;

          const referenceResult = await client.query(
            `SELECT EXISTS (
               SELECT 1
               FROM attachment_objects
               WHERE blob_id = $1
             ) AS has_references`,
            [candidate.id],
          );
          if (referenceResult.rows[0]?.has_references) {
            await client.query(
              `UPDATE attachment_blobs
               SET ref_count = (
                     SELECT COUNT(*)::bigint
                     FROM attachment_objects
                     WHERE blob_id = $1
                   ),
                   orphaned_at = NULL,
                   status = 'ready',
                   updated_at = NOW()
               WHERE id = $1`,
              [candidate.id],
            );
            return null;
          }

          if (row.status === 'ready') {
            const updateResult = await client.query(
              `UPDATE attachment_blobs
               SET status = 'deleting',
                   updated_at = NOW()
               WHERE id = $1
                 AND status = 'ready'
                 AND NOT EXISTS (
                   SELECT 1 FROM attachment_objects WHERE blob_id = $1
                 )
               RETURNING id`,
              [candidate.id],
            );
            if (updateResult.rowCount !== 1) return null;
          } else if (row.status !== 'deleting') {
            return null;
          }

          return {
            id: row.id,
            bucket: row.bucket,
            objectKey: row.object_key,
          };
        });

        if (!blob) {
          summary.retained += 1;
          continue;
        }

        await objectStore.removeObject(blob.bucket, blob.objectKey);
        const deleteResult = await withTransaction(dbPool, async (client) => (
          client.query(
            `DELETE FROM attachment_blobs
             WHERE id = $1
               AND status = 'deleting'
               AND NOT EXISTS (
                 SELECT 1 FROM attachment_objects WHERE blob_id = $1
               )`,
            [blob.id],
          )
        ));
        if (deleteResult.rowCount === 1) {
          summary.deleted += 1;
        } else {
          summary.retained += 1;
        }
      } catch (error) {
        summary.failed += 1;
        logger.error('[ATTACHMENT_BLOB_GC] physical blob cleanup failed', {
          blob_id: String(candidate.id),
          error: error instanceof Error ? error.message : String(error || ''),
        });
      }
    }

    return summary;
  }

  return Object.freeze({
    config,
    assertUploadAllowed,
    stageUploadedAttachments,
    deleteStagedAttachment,
    reserveForMessage,
    acknowledgeScyllaWrite,
    commitReservation,
    releaseReservation,
    cleanupExpiredStaged,
    cleanupOrphanedBlobs,
  });
}

export function createAttachmentReservationId(clientMessageId) {
  const normalized = typeof clientMessageId === 'string' ? clientMessageId.trim() : '';
  return normalized ? normalized.slice(0, 128) : `attachment-${randomUUID()}`;
}
