import { pool } from '../db.js';
import type { QueryResultRow } from 'pg';
import type { DatabaseQueryable } from '../db/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE_RE = /^\d+$/;

export interface ConversationIdentityRow extends QueryResultRow {
  id: string;
  public_id: string | null;
  type: string;
  owner_id: string | null;
  parent_conversation_id: string | null;
  permissions: unknown;
}

export function isUuid(value: unknown): boolean {
  return UUID_RE.test(String(value || ''));
}

export function isSnowflakeId(value: unknown): boolean {
  return SNOWFLAKE_RE.test(String(value || ''));
}

export async function findConversationByIdentifier(
  identifier: unknown,
  db: DatabaseQueryable = pool,
): Promise<ConversationIdentityRow | null> {
  const value = String(identifier || '').trim();
  if (!value) return null;

  let result;

  if (isUuid(value)) {
    result = await db.query<ConversationIdentityRow>(
      `SELECT id, public_id, type, owner_id, parent_conversation_id, permissions
       FROM conversations
       WHERE id = $1
       LIMIT 1`,
      [value]
    );
  } else if (isSnowflakeId(value)) {
    result = await db.query<ConversationIdentityRow>(
      `SELECT id, public_id, type, owner_id, parent_conversation_id, permissions
       FROM conversations
       WHERE public_id = $1
       LIMIT 1`,
      [value]
    );
  } else {
    return null;
  }

  return result.rows[0] || null;
}

export async function resolveConversationId(
  identifier: unknown,
  db: DatabaseQueryable = pool,
): Promise<string | null> {
  const row = await findConversationByIdentifier(identifier, db);
  return row?.id || null;
}

export async function requireConversationId(
  identifier: unknown,
  db: DatabaseQueryable = pool,
): Promise<string> {
  const id = await resolveConversationId(identifier, db);
  if (!id) {
    throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
  }
  return id;
}
