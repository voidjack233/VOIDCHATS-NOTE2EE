import { randomUUID } from 'node:crypto';

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

const MAX_STAGED_ATTACHMENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_ATTACHMENT_RESERVATION_TTL_SECONDS = 60 * 60;
const MAX_STAGED_ATTACHMENT_MAX_COUNT = 500;
const MAX_STAGED_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_ATTACHMENT_CLEANUP_INTERVAL_SECONDS = 24 * 60 * 60;
const MAX_ATTACHMENT_CLEANUP_BATCH_SIZE = 500;
const MAX_ATTACHMENT_RECONCILIATION_BATCH_SIZE = 100;

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
  });
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
  if (!objectStore || typeof objectStore.removeObject !== 'function') {
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
    const incomingBytes = attachments.reduce(
      (total, attachment) => total + Number(attachment.sizeBytes || 0),
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
        incomingCount: attachments.length,
        incomingBytes,
        maxCount: config.stagedMaxCount,
        maxBytes: config.stagedMaxBytes,
      });

      for (const attachment of attachments) {
        await client.query(
          `INSERT INTO attachment_objects (
             id,
             conversation_id,
             uploader_id,
             bucket,
             object_key,
             status,
             size_bytes,
             staged_at,
             expires_at
           )
           VALUES (
             $1, $2, $3, $4, $5, 'staged', $6, NOW(),
             NOW() + ($7 * INTERVAL '1 second')
           )`,
          [
            attachment.id,
            conversationId,
            userId,
            bucket,
            attachment.objectKey,
            attachment.sizeBytes,
            config.stagedTtlSeconds,
          ],
        );
      }
    });
  }

  async function deleteStagedAttachment({ attachmentId, userId, conversationId }) {
    return withTransaction(dbPool, async (client) => {
      const result = await client.query(
        `SELECT id, conversation_id, uploader_id, bucket, object_key, status
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

      await objectStore.removeObject(row.bucket, row.object_key);
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
        };
      }

      const updateResult = await client.query(
        `UPDATE attachment_objects
         SET status = 'reserved',
             reserved_at = NOW(),
             reserved_until = NOW() + ($4 * INTERVAL '1 second'),
             reservation_id = $2,
             message_id = $3,
             scylla_write_policy = $5
         WHERE id = ANY($1::uuid[])
           AND status = 'staged'
           AND expires_at > NOW()
         RETURNING id`,
        [
          attachmentIds,
          reservationId,
          messageId,
          config.reservationTtlSeconds,
          ATTACHMENT_MESSAGE_WRITE_POLICY,
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
      };
    });
  }

  async function commitReservation(queryable, {
    attachmentIds,
    reservationId,
    messageId,
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
       RETURNING id`,
      [attachmentIds, reservationId, messageId],
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
           scylla_write_policy = NULL
       WHERE id = ANY($1::uuid[])
         AND status = 'reserved'
         AND reservation_id = $2
         AND message_id = $3`,
      [attachmentIds, reservationId, messageId],
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
            `SELECT id, bucket, object_key
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

          await objectStore.removeObject(row.bucket, row.object_key);
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

  return Object.freeze({
    config,
    assertUploadAllowed,
    stageUploadedAttachments,
    deleteStagedAttachment,
    reserveForMessage,
    commitReservation,
    releaseReservation,
    cleanupExpiredStaged,
  });
}

export function createAttachmentReservationId(clientMessageId) {
  const normalized = typeof clientMessageId === 'string' ? clientMessageId.trim() : '';
  return normalized ? normalized.slice(0, 128) : `attachment-${randomUUID()}`;
}
