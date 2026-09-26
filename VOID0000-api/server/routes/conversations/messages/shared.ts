import { pool } from '../../../db.js';
import scylla, { cassandra } from '../../../scylla.js';
import { findConversationByIdentifier } from '../../../utils/conversationIdentity.js';
import type { ConversationIdentityRow } from '../../../utils/conversationIdentity.js';
import { resolveMessageStorageConversation } from '../../../utils/messageConversation.js';
import type { AttachmentMessage } from '../../../utils/attachmentDeliveryCore.js';
import { historyMetrics } from '../../../health/historyMetrics.js';
import { reactionState } from '../../../reactions/index.js';

export { pool, scylla, cassandra };

export interface MessageMembershipRow extends Record<string, unknown> {
  role: string;
  last_message_sent_at: Date | null;
}

interface UserIdRow extends Record<string, unknown> {
  user_id: string;
}

interface MentionRow extends Record<string, unknown> {
  user_id: string;
  username: string;
}

export interface MappedStoredMessage extends AttachmentMessage {
  conversation_id: string;
  conversation_public_id: string | null;
  message_id: string;
  sender_id: string;
  content: string;
  link_preview: unknown;
  message_type: unknown;
  reply_to: string | null;
  attachments: string[];
  forwarded: unknown;
  mentions: unknown;
  is_edited: unknown;
  edited_at: string | null;
  is_deleted: unknown;
  created_at: string | undefined;
}

export interface ConversationContexts {
  conversation: ConversationIdentityRow;
  storageConversation: Awaited<ReturnType<typeof resolveMessageStorageConversation>>;
  conversationId: string;
  conversationPublic: string | null;
  storageConversationId: string;
}

export interface NormalizedMention {
  user_id: string;
  username: string | undefined;
}

export interface ReactionSummary {
  count: number;
  me: boolean;
}

export type ReactionsByMessage = Record<string, Record<string, ReactionSummary>>;

function storedRowValue(row: unknown, key: string): unknown {
  return row && typeof row === 'object' ? Reflect.get(row, key) : undefined;
}

function requiredStoredId(value: unknown, field: string): string {
  if (value == null) {
    throw new TypeError(`Stored message is missing ${field}`);
  }
  return String(value);
}

function optionalStoredDate(value: unknown): string | undefined {
  return value instanceof Date ? value.toISOString() : undefined;
}

function normalizeStoredStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export async function verifyMembership(
  conversationId: string,
  userId: string,
): Promise<MessageMembershipRow | null> {
  const result = await historyMetrics.time('membership', () => pool.query<MessageMembershipRow>(
    `SELECT role, last_message_sent_at FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  ));
  return result.rows[0] || null;
}

export async function getConversationMembers(conversationId: string, queryable: Pick<typeof pool, 'query'> = pool): Promise<string[]> {
  const result = await queryable.query<UserIdRow>(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
    [conversationId]
  );
  return result.rows.map((row) => row.user_id);
}

export function conversationPublicId(
  conversation: Pick<ConversationIdentityRow, 'public_id'> | null | undefined,
): string | null {
  return conversation?.public_id ? String(conversation.public_id) : null;
}

export async function resolveConversationContexts(
  conversationIdentifier: unknown,
): Promise<ConversationContexts | null> {
  const conversation = await historyMetrics.time('conversation', () => findConversationByIdentifier(conversationIdentifier));
  if (!conversation) {
    return null;
  }

  const storageConversation = await historyMetrics.time('storage_resolution', () => resolveMessageStorageConversation(conversation));

  return {
    conversation,
    storageConversation,
    conversationId: conversation.id,
    conversationPublic: conversationPublicId(conversation),
    storageConversationId: storageConversation?.id || conversation.id,
  };
}

export function mapStoredMessageRow(
  row: unknown,
  conversationPublic: string | null,
): MappedStoredMessage {
  const isDeleted = storedRowValue(row, 'is_deleted');
  const content = storedRowValue(row, 'content');
  const attachments = storedRowValue(row, 'attachments');
  const editedAt = storedRowValue(row, 'edited_at');
  const createdAt = storedRowValue(row, 'created_at');
  return {
    conversation_id: requiredStoredId(storedRowValue(row, 'conversation_id'), 'conversation_id'),
    conversation_public_id: conversationPublic,
    message_id: requiredStoredId(storedRowValue(row, 'message_id'), 'message_id'),
    sender_id: requiredStoredId(storedRowValue(row, 'sender_id'), 'sender_id'),
    content: isDeleted ? '[deleted]' : (typeof content === 'string' ? content : ''),
    link_preview: isDeleted ? null : parseStoredMessageMetadata(storedRowValue(row, 'link_preview')),
    message_type: storedRowValue(row, 'message_type'),
    reply_to: storedRowValue(row, 'reply_to') != null
      ? String(storedRowValue(row, 'reply_to'))
      : null,
    attachments: isDeleted ? [] : normalizeStoredStringList(attachments),
    forwarded: isDeleted ? null : parseStoredMessageMetadata(storedRowValue(row, 'forwarded')),
    mentions: isDeleted ? [] : parseStoredMessageMetadata(storedRowValue(row, 'mentions'), []),
    is_edited: storedRowValue(row, 'is_edited'),
    edited_at: optionalStoredDate(editedAt) || null,
    is_deleted: isDeleted,
    created_at: optionalStoredDate(createdAt),
  };
}

export function parseStoredMessageMetadata(
  value: unknown,
  fallback: unknown = null,
): unknown {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return fallback;
  }
}

export function normalizeForwardedMetadata(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const normalized: Record<string, string> = {};

  const readString = (key: string): string => {
    const candidate = Reflect.get(value, key);
    return typeof candidate === 'string' ? candidate : '';
  };

  if (readString('original_message_id').trim()) {
    normalized.original_message_id = readString('original_message_id').trim();
  }
  if (readString('original_sender_id').trim()) {
    normalized.original_sender_id = readString('original_sender_id').trim();
  }
  if (readString('original_sender_name').trim()) {
    normalized.original_sender_name = readString('original_sender_name').trim();
  }
  if (readString('original_conversation_id').trim()) {
    normalized.original_conversation_id = readString('original_conversation_id').trim();
  }
  if (readString('original_conversation_name').trim()) {
    normalized.original_conversation_name = readString('original_conversation_name').trim();
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export async function normalizeMentionMetadata(
  conversationId: string,
  conversationType: string,
  mentions: unknown,
): Promise<NormalizedMention[]> {
  if (mentions == null) {
    return [];
  }

  if (!Array.isArray(mentions)) {
    throw new Error('mentions must be an array');
  }

  if (mentions.length === 0) {
    return [];
  }

  if (conversationType !== 'group') {
    throw new Error('Mentions are only supported in group conversations');
  }

  if (mentions.length > 25) {
    throw new Error('Too many mentions in one message');
  }

  const orderedIds: string[] = [];
  const seenIds = new Set<string>();

  for (const entry of mentions) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Invalid mention entry');
    }

    const rawUserId = Reflect.get(entry, 'user_id');
    const userId = typeof rawUserId === 'string' ? rawUserId.trim() : '';
    if (!userId) {
      throw new Error('Each mention must include a user_id');
    }

    if (seenIds.has(userId)) {
      continue;
    }

    seenIds.add(userId);
    orderedIds.push(userId);
  }

  if (orderedIds.length === 0) {
    return [];
  }

  const result = await pool.query<MentionRow>(
    `SELECT cm.user_id::text AS user_id, u.username
     FROM conversation_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = $1 AND cm.user_id = ANY($2::uuid[])`,
    [conversationId, orderedIds]
  );

  const usernamesById = new Map(result.rows.map((row) => [row.user_id, row.username]));
  if (usernamesById.size !== orderedIds.length) {
    throw new Error('One or more mentioned users are not members of this group');
  }

  return orderedIds.map((userId) => ({
    user_id: userId,
    username: usernamesById.get(userId),
  }));
}

export function serializeStoredMessageMetadata(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (Array.isArray(value) && value.length === 0) {
    return null;
  }

  return JSON.stringify(value);
}

export async function batchFetchReactions(
  conversationId: string,
  messageIds: readonly string[],
  currentUserId?: string | null,
): Promise<{ reactions: ReactionsByMessage; revisions: Record<string, string> }> {
  return reactionState.batch(conversationId, messageIds, currentUserId, (stage, work) => historyMetrics.time(stage, work));
}
