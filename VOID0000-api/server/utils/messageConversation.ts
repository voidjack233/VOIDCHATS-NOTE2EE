import { pool } from '../db.js';
import type { QueryResultRow } from 'pg';
import type { DatabaseQueryable } from '../db/types.js';

export interface MessageStorageConversation extends QueryResultRow {
  id: string;
  public_id?: string | null;
  type: string;
  owner_id?: string | null;
  parent_conversation_id?: string | null;
  slowmode_seconds?: number | null;
}

export async function resolveMessageStorageConversation(
  conversation: MessageStorageConversation | null | undefined,
  db: DatabaseQueryable = pool,
): Promise<MessageStorageConversation | null | undefined> {
  if (!conversation || conversation.type !== 'group') {
    return conversation;
  }

  const result = await db.query<MessageStorageConversation>(
    `SELECT id, public_id, type, owner_id, parent_conversation_id, slowmode_seconds
     FROM conversations
     WHERE parent_conversation_id = $1
       AND type = 'channel'
     ORDER BY
       CASE WHEN LOWER(name) = 'general' THEN 0 ELSE 1 END,
       created_at ASC
     LIMIT 1`,
    [conversation.id]
  );

  return result.rows[0] || conversation;
}
