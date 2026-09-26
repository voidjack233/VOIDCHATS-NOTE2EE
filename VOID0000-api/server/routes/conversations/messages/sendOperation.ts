import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export class SendOperationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

interface OperationRow {
  message_id: string;
  storage_conversation_id: string;
  request_hash: string;
  created_at: Date;
  completed_at: Date | null;
  effects_scheduled_at: Date | null;
}

export async function claimMessageSend({
  dbPool, userId, conversationId, storageConversationId, clientMessageId, payload, newMessageId, restoreLegacy,
}: {
  dbPool: { connect(): Promise<PoolClient> };
  userId: string; conversationId: string; storageConversationId: string; clientMessageId: string;
  payload: unknown; newMessageId: string;
  restoreLegacy: (client: PoolClient) => Promise<string | null>;
}) {
  const client = await dbPool.connect();
  const key = JSON.stringify(['message-send-v1', userId, conversationId, clientMessageId]);
  const identity = [userId, conversationId, clientMessageId];
  let locked = false, closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    let failure: Error | undefined;
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
    } catch (error) { failure = error instanceof Error ? error : new Error('Send lock release failed'); }
    // A broken connection must not return to the pool with a session lock.
    client.release(failure);
  }
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [key]);
    if (lock.rows[0]?.acquired !== true) throw new SendOperationError(425, 'MESSAGE_SEND_IN_PROGRESS', 'Message is already being processed');
    locked = true;
    const hash = createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
    const result = await client.query<OperationRow>(
      'SELECT * FROM message_send_operations WHERE user_id=$1 AND conversation_id=$2 AND client_message_id=$3', identity,
    );
    let row = result.rows[0];
    const resumed = Boolean(row);
    if (!row) {
      // Adopt a pre-migration mapping without applying unread/fanout again.
      // Cache failure here is uncertain, not permission to mint another ID.
      const legacyId = await restoreLegacy(client);
      row = (await client.query<OperationRow>(
        `INSERT INTO message_send_operations(user_id,conversation_id,client_message_id,storage_conversation_id,message_id,request_hash,completed_at,effects_scheduled_at)
         VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN NOW() END,CASE WHEN $7 THEN NOW() END) RETURNING *`,
        [...identity, storageConversationId, legacyId ?? newMessageId, hash, Boolean(legacyId)],
      )).rows[0];
    }
    if (row.request_hash !== hash || row.storage_conversation_id !== storageConversationId) {
      throw new SendOperationError(409, 'CLIENT_MESSAGE_MISMATCH', 'This message operation was already used with different content');
    }
    return {
      client, row, resumed, close,
      // The caller's acceptance transaction owns this update and unread changes.
      async complete() {
        const result = await client.query(
          `UPDATE message_send_operations SET completed_at=NOW()
           WHERE user_id=$1 AND conversation_id=$2 AND client_message_id=$3 AND completed_at IS NULL RETURNING message_id`, identity,
        );
        if (result.rowCount !== 1) throw new Error('Message acceptance state changed');
      },
      async effectsScheduled() {
        // Scheduling is not delivery acknowledgement. Pub/Sub and push remain
        // best-effort; a crash here can replay the stable event_id, not the send.
        await client.query(`UPDATE message_send_operations SET effects_scheduled_at=NOW()
          WHERE user_id=$1 AND conversation_id=$2 AND client_message_id=$3 AND completed_at IS NOT NULL`, identity);
      },
    };
  } catch (error) { await close(); throw error; }
}

export type MessageSendOperation = Awaited<ReturnType<typeof claimMessageSend>>;
