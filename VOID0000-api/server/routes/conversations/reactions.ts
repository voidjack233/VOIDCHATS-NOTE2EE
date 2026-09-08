// server/routes/conversations/reactions.js
import { Router } from 'express';
import { pool } from '../../db.js';
import { canInteractInConversation } from '../../utils/conversationInteraction.js';
import scylla, { cassandra } from '../../scylla.js';
import { queueReactionEventToUser } from '../../gateway/client.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { reactionEventId } from '../../utils/eventIdentity.js';
import { resolveMessageStorageConversation } from '../../utils/messageConversation.js';

const router = Router({ mergeParams: true });
const MAX_UNIQUE_REACTIONS_PER_MESSAGE = 10;
const MAX_REACTION_EMOJI_GRAPHEMES = 1;
const MAX_REACTION_EMOJI_LENGTH = 64;

interface ReactionMembershipRow extends Record<string, unknown> {
  role: string;
}

interface ReactionUserRow extends Record<string, unknown> {
  user_id: string;
}

async function verifyMembership(
  conversationId: string,
  userId: string,
): Promise<ReactionMembershipRow | null> {
  const result = await pool.query(
    `SELECT role FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  return result.rows[0] || null;
}

async function getConversationMembers(conversationId: string): Promise<string[]> {
  const result = await pool.query<ReactionUserRow>(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
    [conversationId]
  );
  return result.rows.map((r) => r.user_id);
}

function conversationPublicId(conversation: { public_id?: unknown } | null): string | null {
  return conversation?.public_id ? String(conversation.public_id) : null;
}

function normalizeReactionCount(value: unknown): number {
  if (value && typeof value === 'object') {
    const toNumber = Reflect.get(value, 'toNumber');
    if (typeof toNumber === 'function') {
      return Number(Reflect.apply(toNumber, value, []));
    }
  }

  return Number(value || 0);
}

function getEmojiGraphemeCount(value: string): number {
  if (!value) return 0;

  if (typeof Intl?.Segmenter === 'function') {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
    ).length;
  }

  return Array.from(value).length;
}

function normalizeReactionEmoji(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length > MAX_REACTION_EMOJI_LENGTH) {
    return null;
  }

  if (getEmojiGraphemeCount(normalized) > MAX_REACTION_EMOJI_GRAPHEMES) {
    return null;
  }

  return normalized;
}

async function resolveConversationContexts(conversationIdentifier: unknown) {
  const conversation = await findConversationByIdentifier(conversationIdentifier);
  if (!conversation) {
    return null;
  }

  const storageConversation = await resolveMessageStorageConversation(conversation);

  return {
    conversation,
    conversationId: conversation.id,
    conversationPublic: conversationPublicId(conversation),
    storageConversationId: storageConversation?.id || conversation.id,
  };
}

// PUT /:emoji — toggle reaction
router.put<{ conversationId: string; messageId: string; emoji: string }>('/:emoji', async (req, res) => {
  const userId = req.user?.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;
  const emoji = normalizeReactionEmoji(decodeURIComponent(req.params.emoji));

  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!emoji) {
    return res.status(400).json({ error: 'Invalid emoji' });
  }

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const {
      conversationId,
      conversationPublic,
      storageConversationId,
    } = resolvedConversation;
    const member = await verifyMembership(conversationId, userId);
    if (!member) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }
    if (!await canInteractInConversation(pool, resolvedConversation.conversation, userId)) {
      return res.status(403).json({ error: 'You can only DM friends' });
    }

    const convUuid = cassandra.types.Uuid.fromString(storageConversationId);
    const msgUuid = cassandra.types.TimeUuid.fromString(messageId);
    const userUuid = cassandra.types.Uuid.fromString(userId);

    const messageExists = await scylla.execute(
      'SELECT message_id FROM messages WHERE conversation_id = ? AND message_id = ?',
      [convUuid, msgUuid],
      { prepare: true }
    );
    if (messageExists.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const existing = await scylla.execute(
      `SELECT user_id FROM message_reactions
       WHERE conversation_id = ? AND message_id = ? AND emoji = ? AND user_id = ?`,
      [convUuid, msgUuid, emoji, userUuid],
      { prepare: true }
    );

    let action: 'add' | 'remove';

    if (existing.rows.length > 0) {
      await Promise.all([
        scylla.execute(
          `DELETE FROM message_reactions
           WHERE conversation_id = ? AND message_id = ? AND emoji = ? AND user_id = ?`,
          [convUuid, msgUuid, emoji, userUuid],
          { prepare: true }
        ),
        scylla.execute(
          `UPDATE reaction_counts SET count = count - 1
           WHERE conversation_id = ? AND message_id = ? AND emoji = ?`,
          [convUuid, msgUuid, emoji],
          { prepare: true }
        ),
        scylla.execute(
          `DELETE FROM user_reactions
           WHERE conversation_id = ? AND user_id = ? AND message_id = ? AND emoji = ?`,
          [convUuid, userUuid, msgUuid, emoji],
          { prepare: true }
        ),
      ]);
      action = 'remove';
    } else {
      const reactionCounts = await scylla.execute(
        `SELECT emoji, count FROM reaction_counts
         WHERE conversation_id = ? AND message_id = ?`,
        [convUuid, msgUuid],
        { prepare: true }
      );

      const activeReactionEmojis = reactionCounts.rows
        .filter((row) => normalizeReactionCount(row.count) > 0)
        .map((row) => row.emoji);

      if (
        !activeReactionEmojis.includes(emoji) &&
        activeReactionEmojis.length >= MAX_UNIQUE_REACTIONS_PER_MESSAGE
      ) {
        return res.status(409).json({
          error: `Maximum of ${MAX_UNIQUE_REACTIONS_PER_MESSAGE} reactions per message`,
          code: 'REACTION_LIMIT_REACHED',
        });
      }

      await Promise.all([
        scylla.execute(
          `INSERT INTO message_reactions (conversation_id, message_id, emoji, user_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [convUuid, msgUuid, emoji, userUuid, new Date()],
          { prepare: true }
        ),
        scylla.execute(
          `UPDATE reaction_counts SET count = count + 1
           WHERE conversation_id = ? AND message_id = ? AND emoji = ?`,
          [convUuid, msgUuid, emoji],
          { prepare: true }
        ),
        scylla.execute(
          `INSERT INTO user_reactions (conversation_id, user_id, message_id, emoji)
           VALUES (?, ?, ?, ?)`,
          [convUuid, userUuid, msgUuid, emoji],
          { prepare: true }
        ),
      ]);
      action = 'add';
    }

    const payload = {
      event_id: reactionEventId({
        conversationId,
        messageId,
        emoji,
        userId,
        action,
      }),
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId,
      emoji,
      user_id: userId,
      action,
    };

    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      if (memberId !== userId) {
        queueReactionEventToUser(memberId, payload);
      }
    });

    res.json({ success: true, ...payload });
  } catch (err) {
    console.error('Reaction toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle reaction' });
  }
});

export default router;
