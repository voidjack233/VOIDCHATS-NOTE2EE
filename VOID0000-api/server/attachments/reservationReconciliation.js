import { randomUUID } from 'node:crypto';

import { extractProtectedAttachmentIds } from './lifecycleCore.js';
import {
  ATTACHMENT_MESSAGE_WRITE_POLICY,
  createAttachmentMessageConsistency,
} from './messageConsistency.js';

const RECONCILIATION_LOCK_KEY = 'attachments:reservation-reconciliation:lock';
const RECONCILIATION_LOCK_TTL_MS = 15 * 60 * 1000;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function normalizeIds(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value).toLowerCase())
    .sort();
}

function hasExactIds(left, right) {
  const normalizedLeft = normalizeIds(left);
  const normalizedRight = normalizeIds(right);
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((id, index) => id === normalizedRight[index]);
}

export function createAttachmentReservationReconciler({
  listExpiredReservationGroups,
  loadStoredMessage,
  markCommitted,
  releaseToStaged,
  batchSize,
  logger = console,
} = {}) {
  if (typeof listExpiredReservationGroups !== 'function') {
    throw new TypeError('Attachment reservation reconciler requires a reservation reader');
  }
  if (typeof loadStoredMessage !== 'function') {
    throw new TypeError('Attachment reservation reconciler requires a message reader');
  }
  if (typeof markCommitted !== 'function' || typeof releaseToStaged !== 'function') {
    throw new TypeError('Attachment reservation reconciler requires transition handlers');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError('Attachment reservation reconciler requires a positive batch size');
  }

  async function runOnce() {
    const groups = await listExpiredReservationGroups(batchSize);
    const summary = {
      selected: groups.length,
      committed: 0,
      released: 0,
      mismatched: 0,
      uncertain: 0,
      stale: 0,
    };

    for (const group of groups) {
      try {
        const message = await loadStoredMessage(group);
        if (!message) {
          if (group.scyllaWritePolicy !== ATTACHMENT_MESSAGE_WRITE_POLICY) {
            summary.uncertain += 1;
            continue;
          }
          const released = await releaseToStaged(group);
          summary[released ? 'released' : 'stale'] += 1;
          continue;
        }

        const senderMatches =
          String(message.senderId) === String(group.uploaderId);
        const attachmentsMatch =
          Array.isArray(message.attachmentIds) &&
          hasExactIds(message.attachmentIds, group.attachmentIds);
        if (!senderMatches || !attachmentsMatch) {
          summary.mismatched += 1;
          continue;
        }

        const committed = await markCommitted(group);
        summary[committed ? 'committed' : 'stale'] += 1;
      } catch (error) {
        summary.uncertain += 1;
        logger.warn('[ATTACHMENT_RECONCILIATION] reservation left unchanged', {
          conversation_id: String(group.conversationId),
          message_id: String(group.messageId),
          error: error instanceof Error ? error.message : String(error || ''),
        });
      }
    }

    return summary;
  }

  return Object.freeze({ runOnce });
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

export function createPostgresAttachmentReservationStore({
  dbPool,
  freshStagedTtlSeconds,
} = {}) {
  if (!dbPool || typeof dbPool.query !== 'function' || typeof dbPool.connect !== 'function') {
    throw new TypeError('Attachment reservation store requires a PostgreSQL pool');
  }
  if (!Number.isSafeInteger(freshStagedTtlSeconds) || freshStagedTtlSeconds <= 0) {
    throw new TypeError('Attachment reservation store requires a positive staged TTL');
  }

  async function listExpiredReservationGroups(batchSize) {
    const result = await dbPool.query(
      `SELECT conversation_id,
              uploader_id,
              reservation_id,
              message_id::text AS message_id,
              scylla_write_policy,
              ARRAY_AGG(id ORDER BY id) AS attachment_ids
       FROM attachment_objects
       WHERE status = 'reserved'
       GROUP BY conversation_id, uploader_id, reservation_id, message_id, scylla_write_policy
       HAVING MAX(reserved_until) <= NOW()
       ORDER BY MIN(reserved_until), conversation_id, message_id
       LIMIT $1`,
      [batchSize],
    );

    return result.rows.map((row) => ({
      conversationId: String(row.conversation_id),
      uploaderId: String(row.uploader_id),
      reservationId: String(row.reservation_id),
      messageId: String(row.message_id),
      scyllaWritePolicy: typeof row.scylla_write_policy === 'string'
        ? row.scylla_write_policy
        : null,
      attachmentIds: normalizeIds(row.attachment_ids),
    }));
  }

  async function transition(group, state) {
    return withTransaction(dbPool, async (client) => {
      const lockedResult = await client.query(
        `SELECT id, scylla_write_policy
         FROM attachment_objects
         WHERE status = 'reserved'
           AND conversation_id = $1
           AND uploader_id = $2
           AND reservation_id = $3
           AND message_id = $4
           AND reserved_until <= NOW()
         ORDER BY id
         FOR UPDATE`,
        [
          group.conversationId,
          group.uploaderId,
          group.reservationId,
          group.messageId,
        ],
      );
      const lockedIds = normalizeIds(lockedResult.rows.map((row) => row.id));
      if (!hasExactIds(lockedIds, group.attachmentIds)) {
        return false;
      }
      if (
        state === 'staged' &&
        (
          group.scyllaWritePolicy !== ATTACHMENT_MESSAGE_WRITE_POLICY ||
          lockedResult.rows.some(
            (row) => row.scylla_write_policy !== ATTACHMENT_MESSAGE_WRITE_POLICY,
          )
        )
      ) {
        return false;
      }

      const result = state === 'committed'
        ? await client.query(
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
               AND reserved_until <= NOW()`,
            [
              group.attachmentIds,
              group.reservationId,
              group.messageId,
              group.uploaderId,
              group.conversationId,
            ],
          )
        : await client.query(
            `UPDATE attachment_objects
             SET status = 'staged',
                 staged_at = NOW(),
                 expires_at = NOW() + ($6 * INTERVAL '1 second'),
                 reserved_at = NULL,
                 reserved_until = NULL,
                 reservation_id = NULL,
                 message_id = NULL,
                 committed_at = NULL,
                 scylla_write_policy = NULL
             WHERE id = ANY($1::uuid[])
               AND status = 'reserved'
               AND reservation_id = $2
               AND message_id = $3
               AND uploader_id = $4
               AND conversation_id = $5
               AND reserved_until <= NOW()`,
            [
              group.attachmentIds,
              group.reservationId,
              group.messageId,
              group.uploaderId,
              group.conversationId,
              freshStagedTtlSeconds,
            ],
          );

      if (result.rowCount !== group.attachmentIds.length) {
        throw new Error('Attachment reservation changed during reconciliation');
      }
      return true;
    });
  }

  return Object.freeze({
    listExpiredReservationGroups,
    markCommitted: (group) => transition(group, 'committed'),
    releaseToStaged: (group) => transition(group, 'staged'),
  });
}

export function createScyllaAttachmentMessageReader({
  dbPool,
  scyllaClient,
  cassandraDriver,
  resolveStorageConversation,
} = {}) {
  if (!dbPool || typeof dbPool.query !== 'function') {
    throw new TypeError('Attachment message reader requires a PostgreSQL pool');
  }
  if (!scyllaClient || typeof scyllaClient.execute !== 'function') {
    throw new TypeError('Attachment message reader requires a Scylla client');
  }
  if (typeof resolveStorageConversation !== 'function') {
    throw new TypeError('Attachment message reader requires storage resolution');
  }
  const messageConsistency = createAttachmentMessageConsistency({
    scyllaClient,
    cassandraDriver,
  });

  return async function loadStoredMessage(group) {
    const conversationResult = await dbPool.query(
      `SELECT id, public_id, type, owner_id, parent_conversation_id, slowmode_seconds
       FROM conversations
       WHERE id = $1
       LIMIT 1`,
      [group.conversationId],
    );
    const conversation = conversationResult.rows[0];
    if (!conversation) {
      throw new Error('Reservation conversation could not be resolved');
    }

    const storageConversation = await resolveStorageConversation(
      conversation,
      dbPool,
    );
    const result = await messageConsistency.read(
      `SELECT sender_id, attachments
       FROM messages
       WHERE conversation_id = ? AND message_id = ?`,
      [
        cassandraDriver.types.Uuid.fromString(String(storageConversation.id)),
        cassandraDriver.types.TimeUuid.fromString(String(group.messageId)),
      ],
    );
    if (!result || !Array.isArray(result.rows) || result.rows.length > 1) {
      throw new Error('Attachment reconciliation received a malformed Scylla result');
    }
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    let attachmentIds = null;
    try {
      attachmentIds = extractProtectedAttachmentIds(row.attachments);
    } catch {
      // A found message with malformed or historical attachment data is a
      // mismatch, never proof that a reservation can be released.
    }

    return {
      senderId: row.sender_id?.toString(),
      attachmentIds,
    };
  };
}

export function createAttachmentReservationReconciliationRunner({
  reconciler,
  lockClient,
  intervalSeconds,
  logger = console,
} = {}) {
  if (!reconciler || typeof reconciler.runOnce !== 'function') {
    throw new TypeError('Attachment reconciliation runner requires a reconciler');
  }
  if (
    !lockClient ||
    typeof lockClient.set !== 'function' ||
    typeof lockClient.eval !== 'function'
  ) {
    throw new TypeError('Attachment reconciliation runner requires a distributed lock client');
  }
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new TypeError('Attachment reconciliation runner requires a positive interval');
  }

  let interval = null;
  let runPromise = null;

  async function runOnce() {
    if (runPromise) {
      return runPromise;
    }

    runPromise = (async () => {
      const lockToken = randomUUID();
      let acquired = false;

      try {
        acquired = await lockClient.set(
          RECONCILIATION_LOCK_KEY,
          lockToken,
          'PX',
          RECONCILIATION_LOCK_TTL_MS,
          'NX',
        ) === 'OK';
      } catch (error) {
        logger.error('[ATTACHMENT_RECONCILIATION] distributed lock unavailable; run skipped', {
          error: error instanceof Error ? error.message : String(error || ''),
        });
        return { skipped: true, reason: 'lock_unavailable' };
      }

      if (!acquired) {
        return { skipped: true, reason: 'lock_held' };
      }

      try {
        return await reconciler.runOnce();
      } finally {
        await lockClient.eval(
          RELEASE_LOCK_SCRIPT,
          1,
          RECONCILIATION_LOCK_KEY,
          lockToken,
        ).catch((error) => {
          logger.warn('[ATTACHMENT_RECONCILIATION] failed to release distributed lock', {
            error: error instanceof Error ? error.message : String(error || ''),
          });
        });
      }
    })();

    try {
      return await runPromise;
    } finally {
      runPromise = null;
    }
  }

  function start() {
    if (interval) return;
    interval = setInterval(
      () => void runOnce(),
      intervalSeconds * 1000,
    );
    interval.unref?.();
  }

  function stop() {
    if (!interval) return;
    clearInterval(interval);
    interval = null;
  }

  return Object.freeze({ runOnce, start, stop });
}
