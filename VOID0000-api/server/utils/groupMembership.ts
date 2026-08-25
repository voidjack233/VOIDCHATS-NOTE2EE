import { EVENTS } from '../gateway/protocol.js';
import { sendLiveEventToUser } from '../gateway/client.js';
import { findConversationByIdentifier } from './conversationIdentity.js';
import type { QueryResultRow } from 'pg';
import type { DatabaseQueryable } from '../db/types.js';
import type { ConversationIdentityRow } from './conversationIdentity.js';

interface IdRow extends QueryResultRow {
  id: string;
}

interface MembershipRow extends QueryResultRow {
  role: string;
}

interface GroupConversationRow extends QueryResultRow {
  id: string;
  type: string;
  owner_id: string | null;
}

interface GroupMemberRow extends QueryResultRow {
  user_id: string;
  role: string;
  joined_at: Date | null;
}

export type ConversationUpdateSource = {
  id: string;
  public_id?: string | null;
  type: string;
  owner_id?: string | null;
};

export function uniqueUserIds(values: unknown = []): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(
    values
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
  )];
}

export async function getChildChannelIds(
  db: DatabaseQueryable,
  conversationId: string,
): Promise<string[]> {
  const result = await db.query<IdRow>(
    `SELECT id FROM conversations WHERE parent_conversation_id = $1`,
    [conversationId]
  );
  return result.rows.map((row) => row.id);
}

export async function resolveMembershipConversation(
  db: DatabaseQueryable,
  requestedConversationId: unknown,
): Promise<ConversationIdentityRow | null> {
  const requestedConversation = await findConversationByIdentifier(requestedConversationId, db);
  if (!requestedConversation) {
    return null;
  }

  if (requestedConversation.type !== 'channel' || !requestedConversation.parent_conversation_id) {
    return requestedConversation;
  }

  const parentResult = await db.query<ConversationIdentityRow>(
    `SELECT id, public_id, type, owner_id, parent_conversation_id, permissions
     FROM conversations
     WHERE id = $1
     LIMIT 1`,
    [requestedConversation.parent_conversation_id]
  );

  return parentResult.rows[0] || null;
}

export async function getGroupMembership(
  db: DatabaseQueryable,
  conversationId: string,
  userId: string,
): Promise<MembershipRow | null> {
  const result = await db.query<MembershipRow>(
    `SELECT role
     FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );

  return result.rows[0] || null;
}

export async function ensureGroupOwner(
  db: DatabaseQueryable,
  conversationId: string,
): Promise<{ repaired: boolean; ownerUserId: string | null }> {
  const conversationResult = await db.query<GroupConversationRow>(
    `SELECT id, type, owner_id
     FROM conversations
     WHERE id = $1
     LIMIT 1
     FOR UPDATE`,
    [conversationId],
  );
  const conversation = conversationResult.rows[0] || null;
  if (!conversation || conversation.type !== 'group') {
    return { repaired: false, ownerUserId: conversation?.owner_id || null };
  }

  const membersResult = await db.query<GroupMemberRow>(
    `SELECT user_id::text AS user_id, role, joined_at
     FROM conversation_members
     WHERE conversation_id = $1
     ORDER BY joined_at ASC NULLS LAST,
              user_id ASC`,
    [conversationId],
  );
  const members = membersResult.rows;
  if (members.length === 0) {
    return { repaired: false, ownerUserId: null };
  }

  const configuredOwner = members.find(
    (member) => String(member.user_id) === String(conversation.owner_id || ''),
  );
  const roleOwner = members.find((member) => member.role === 'owner');
  const owner = configuredOwner || roleOwner || members[0];
  const ownerCount = members.filter((member) => member.role === 'owner').length;
  const isConsistent =
    String(conversation.owner_id || '') === String(owner.user_id) &&
    owner.role === 'owner' &&
    ownerCount === 1;

  if (isConsistent) {
    return { repaired: false, ownerUserId: String(owner.user_id) };
  }

  const childChannelIds = await getChildChannelIds(db, conversationId);
  const affectedConversationIds = [conversationId, ...childChannelIds];

  await db.query(
    `UPDATE conversations
     SET owner_id = $1, updated_at = NOW()
     WHERE id = ANY($2::uuid[])`,
    [owner.user_id, affectedConversationIds],
  );
  await db.query(
    `UPDATE conversation_members
     SET role = CASE
       WHEN user_id = $1 THEN 'owner'
       WHEN role = 'owner' THEN 'admin'
       ELSE role
     END
     WHERE conversation_id = ANY($2::uuid[])
       AND (user_id = $1 OR role = 'owner')`,
    [owner.user_id, affectedConversationIds],
  );

  return { repaired: true, ownerUserId: String(owner.user_id) };
}

export async function validateFriendships(
  db: DatabaseQueryable,
  requesterId: string,
  memberIds: readonly string[],
): Promise<string | null> {
  for (const memberId of memberIds) {
    const friendCheck = await db.query(
      `SELECT id FROM friendships
       WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
         AND status = 'accepted'
       LIMIT 1`,
      [requesterId, memberId]
    );

    if (friendCheck.rows.length === 0) {
      return memberId;
    }
  }

  return null;
}

export async function emitConversationUpdate(
  conversation: ConversationUpdateSource,
  memberIds: readonly string[],
  memberCount: number,
  memberRolesById: Record<string, string> | null = null,
): Promise<void> {
  memberIds.forEach((memberId) => {
    const payload = {
      conversation: {
        id: conversation.id,
        public_id: conversation.public_id ? String(conversation.public_id) : null,
        type: conversation.type,
        owner_id: conversation.owner_id || null,
        member_count: memberCount,
        updated_at: new Date().toISOString(),
        ...(memberRolesById && memberRolesById[memberId]
          ? { role: memberRolesById[memberId] }
          : {}),
      },
    };

    sendLiveEventToUser(memberId, EVENTS.CONVERSATION_UPDATE, payload);
  });
}
