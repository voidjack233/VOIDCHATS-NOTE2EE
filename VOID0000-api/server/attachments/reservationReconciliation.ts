import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';

import { extractProtectedAttachmentIds } from './lifecycleCore.js';
import {
  ATTACHMENT_MESSAGE_WRITE_POLICY,
  createAttachmentMessageConsistency,
} from './messageConsistency.js';
import type { DatabaseQueryable } from '../db/types.js';
import type { MessageStorageConversation } from '../utils/messageConversation.js';

const RECONCILIATION_LOCK_KEY = 'attachments:reservation-reconciliation:lock';
const RECONCILIATION_LOCK_TTL_MS = 15 * 60 * 1000;
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export type AttachmentReservationGroup = {
  conversationId: string;
  uploaderId: string;
  reservationId: string;
  messageId: string;
  scyllaWritePolicy: string | null;
  scyllaWriteAcknowledged: boolean;
  attachmentIds: string[];
};

type StoredAttachmentMessage = {
  senderId: string | undefined;
  attachmentIds: string[] | null;
};

type ReconciliationSummary = {
  selected: number;
  committed: number;
  released: number;
  mismatched: number;
  uncertain: number;
  stale: number;
};

type ReconcilerLogger = {
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
};

type ReconcilerOptions = {
  listExpiredReservationGroups?: (
    batchSize: number,
  ) => Promise<AttachmentReservationGroup[]>;
  loadStoredMessage?: (
    group: AttachmentReservationGroup,
  ) => Promise<StoredAttachmentMessage | null>;
  markCommitted?: (group: AttachmentReservationGroup) => Promise<boolean>;
  releaseToStaged?: (group: AttachmentReservationGroup) => Promise<boolean>;
  batchSize?: number;
  logger?: ReconcilerLogger;
};

interface ReservationRow extends QueryResultRow {
  id: string;
  conversation_id: string;
  uploader_id: string;
  reservation_id: string;
  message_id: string;
  scylla_write_policy_confirmed: boolean;
  scylla_write_acknowledged: boolean;
  scylla_write_policy: string | null;
  scylla_write_acknowledged_at: Date | null;
  attachment_ids: unknown[];
}

interface ReservationDbClient extends DatabaseQueryable {
  release(): void;
}

interface ReservationDbPool extends DatabaseQueryable {
  connect(): Promise<ReservationDbClient>;
}

type ReservationStoreOptions = {
  dbPool?: ReservationDbPool;
  freshStagedTtlSeconds?: number;
};

type CassandraDriver = {
  types: {
    Uuid: { fromString(value: string): unknown };
    TimeUuid: { fromString(value: string): unknown };
    consistencies: { localQuorum?: number };
  };
};

type ScyllaClient = {
  execute(
    query: string,
    parameters: unknown[],
    options: { prepare: true; consistency: number },
  ): Promise<unknown>;
};

type MessageReaderOptions = {
  dbPool?: DatabaseQueryable;
  scyllaClient?: ScyllaClient;
  cassandraDriver?: CassandraDriver;
  resolveStorageConversation?: (
    conversation: MessageStorageConversation,
    dbPool: DatabaseQueryable,
  ) => Promise<MessageStorageConversation | null | undefined>;
};

type DistributedLockClient = {
  set(
    key: string,
    value: string,
    mode: 'PX',
    durationMs: number,
    condition: 'NX',
  ): Promise<string | null>;
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
};

type ReconciliationRunnerOptions = {
  reconciler?: { runOnce(): Promise<unknown> };
  lockClient?: DistributedLockClient;
  intervalSeconds?: number;
  logger?: ReconcilerLogger;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeIds(values: unknown): string[] {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value).toLowerCase())
    .sort();
}

function hasExactIds(left: unknown, right: unknown): boolean {
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
}: ReconcilerOptions = {}) {
  if (typeof listExpiredReservationGroups !== 'function') {
    throw new TypeError('Attachment reservation reconciler requires a reservation reader');
  }
  if (typeof loadStoredMessage !== 'function') {
    throw new TypeError('Attachment reservation reconciler requires a message reader');
  }
  if (typeof markCommitted !== 'function' || typeof releaseToStaged !== 'function') {
    throw new TypeError('Attachment reservation reconciler requires transition handlers');
  }
  if (typeof batchSize !== 'number' || !Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError('Attachment reservation reconciler requires a positive batch size');
  }
  const activeListGroups = listExpiredReservationGroups;
  const activeLoadMessage = loadStoredMessage;
  const activeMarkCommitted = markCommitted;
  const activeReleaseToStaged = releaseToStaged;
  const activeBatchSize = batchSize;

  async function runOnce(): Promise<ReconciliationSummary> {
    const groups = await activeListGroups(activeBatchSize);
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
        const message = await activeLoadMessage(group);
        if (!message) {
          if (
            group.scyllaWritePolicy !== ATTACHMENT_MESSAGE_WRITE_POLICY ||
            group.scyllaWriteAcknowledged !== true
          ) {
            summary.uncertain += 1;
            continue;
          }
          const released = await activeReleaseToStaged(group);
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

        const committed = await activeMarkCommitted(group);
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

async function withTransaction<Result>(
  dbPool: ReservationDbPool,
  callback: (client: ReservationDbClient) => Promise<Result>,
): Promise<Result> {
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
}: ReservationStoreOptions = {}) {
  if (!dbPool || typeof dbPool.query !== 'function' || typeof dbPool.connect !== 'function') {
    throw new TypeError('Attachment reservation store requires a PostgreSQL pool');
  }
  if (
    typeof freshStagedTtlSeconds !== 'number' ||
    !Number.isSafeInteger(freshStagedTtlSeconds) ||
    freshStagedTtlSeconds <= 0
  ) {
    throw new TypeError('Attachment reservation store requires a positive staged TTL');
  }

  const activeDbPool = dbPool;
  const stagedTtlSeconds = freshStagedTtlSeconds;

  async function listExpiredReservationGroups(
    batchSize: number,
  ): Promise<AttachmentReservationGroup[]> {
    const result = await activeDbPool.query<ReservationRow>(
      `SELECT conversation_id,
              uploader_id,
              reservation_id,
              message_id::text AS message_id,
              BOOL_AND(
                COALESCE(
                  scylla_write_policy = $2,
                  FALSE
                )
              ) AS scylla_write_policy_confirmed,
              BOOL_AND(
                scylla_write_acknowledged_at IS NOT NULL
              ) AS scylla_write_acknowledged,
              ARRAY_AGG(id ORDER BY id) AS attachment_ids
       FROM attachment_objects
       WHERE status = 'reserved'
       GROUP BY conversation_id, uploader_id, reservation_id, message_id
       HAVING MAX(reserved_until) <= NOW()
       ORDER BY MIN(reserved_until), conversation_id, message_id
       LIMIT $1`,
      [batchSize, ATTACHMENT_MESSAGE_WRITE_POLICY],
    );

    return result.rows.map((row) => ({
      conversationId: String(row.conversation_id),
      uploaderId: String(row.uploader_id),
      reservationId: String(row.reservation_id),
      messageId: String(row.message_id),
      scyllaWritePolicy: row.scylla_write_policy_confirmed === true
        ? ATTACHMENT_MESSAGE_WRITE_POLICY
        : null,
      scyllaWriteAcknowledged: row.scylla_write_acknowledged === true,
      attachmentIds: normalizeIds(row.attachment_ids),
    }));
  }

  async function transition(
    group: AttachmentReservationGroup,
    state: 'committed' | 'staged',
  ): Promise<boolean> {
    return withTransaction(activeDbPool, async (client) => {
      const lockedResult = await client.query<ReservationRow>(
        `SELECT id,
                scylla_write_policy,
                scylla_write_acknowledged_at
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
          group.scyllaWriteAcknowledged !== true ||
          lockedResult.rows.some(
            (row) => (
              row.scylla_write_policy !== ATTACHMENT_MESSAGE_WRITE_POLICY ||
              row.scylla_write_acknowledged_at == null
            ),
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
                 scylla_write_policy = NULL,
                 scylla_write_acknowledged_at = NULL
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
              stagedTtlSeconds,
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
    markCommitted: (group: AttachmentReservationGroup) => transition(group, 'committed'),
    releaseToStaged: (group: AttachmentReservationGroup) => transition(group, 'staged'),
  });
}

export function createScyllaAttachmentMessageReader({
  dbPool,
  scyllaClient,
  cassandraDriver,
  resolveStorageConversation,
}: MessageReaderOptions = {}) {
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
  if (!cassandraDriver) {
    throw new TypeError('Attachment message reader requires a Cassandra driver');
  }
  const activeDbPool = dbPool;
  const activeCassandraDriver = cassandraDriver;
  const activeResolver = resolveStorageConversation;

  return async function loadStoredMessage(
    group: AttachmentReservationGroup,
  ): Promise<StoredAttachmentMessage | null> {
    const conversationResult = await activeDbPool.query<MessageStorageConversation>(
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

    const storageConversation = await activeResolver(
      conversation,
      activeDbPool,
    );
    if (!storageConversation) {
      throw new Error('Reservation storage conversation could not be resolved');
    }
    const result = await messageConsistency.read(
      `SELECT sender_id, attachments
       FROM messages
       WHERE conversation_id = ? AND message_id = ?`,
      [
        activeCassandraDriver.types.Uuid.fromString(String(storageConversation.id)),
        activeCassandraDriver.types.TimeUuid.fromString(String(group.messageId)),
      ],
    );
    if (!isRecord(result) || !Array.isArray(result.rows) || result.rows.length > 1) {
      throw new Error('Attachment reconciliation received a malformed Scylla result');
    }
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (!isRecord(row)) {
      throw new Error('Attachment reconciliation received a malformed Scylla result');
    }

    let attachmentIds = null;
    try {
      attachmentIds = extractProtectedAttachmentIds(row.attachments);
    } catch {
      // A found message with malformed or historical attachment data is a
      // mismatch, never proof that a reservation can be released.
    }

    return {
      senderId: row.sender_id == null ? undefined : String(row.sender_id),
      attachmentIds,
    };
  };
}

export function createAttachmentReservationReconciliationRunner({
  reconciler,
  lockClient,
  intervalSeconds,
  logger = console,
}: ReconciliationRunnerOptions = {}) {
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
  if (
    typeof intervalSeconds !== 'number' ||
    !Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds <= 0
  ) {
    throw new TypeError('Attachment reconciliation runner requires a positive interval');
  }

  const activeReconciler = reconciler;
  const activeLockClient = lockClient;
  const activeIntervalSeconds = intervalSeconds;
  let interval: NodeJS.Timeout | null = null;
  let runPromise: Promise<unknown> | null = null;

  async function runOnce() {
    if (runPromise) {
      return runPromise;
    }

    runPromise = (async () => {
      const lockToken = randomUUID();
      let acquired = false;

      try {
        acquired = await activeLockClient.set(
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
        return await activeReconciler.runOnce();
      } finally {
        await activeLockClient.eval(
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
      activeIntervalSeconds * 1000,
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
