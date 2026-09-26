// server/routes/conversations/reactions.js
import { Router } from 'express';
import { pool } from '../../db.js';
import { canInteractInConversation } from '../../utils/conversationInteraction.js';
import scylla, { cassandra } from '../../scylla.js';
import { queueReactionEventToUser } from '../../gateway/client.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { resolveMessageStorageConversation } from '../../utils/messageConversation.js';
import { reactionState } from '../../reactions/index.js';
import { ReactionError } from '../../reactions/state.js';

const router = Router({ mergeParams: true });
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

// PUT ensures presence; DELETE ensures absence. Old toggle clients must reload,
// not repeatedly PUT in an attempt to remove a reaction.
router.all<{ conversationId: string; messageId: string; emoji: string }>('/:emoji', async (req, res, next) => {
  if (req.method !== 'PUT' && req.method !== 'DELETE') return next();
  const userId = req.user?.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;
  const emoji = normalizeReactionEmoji(req.params.emoji);
  const present = req.method === 'PUT';

  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!emoji) {
    return res.status(400).json({ error: 'Invalid emoji' });
  }
  if (req.body?.present !== present) {
    return res.status(409).json({ code: 'REACTION_CLIENT_UPGRADE_REQUIRED', error: 'Reload to update reactions' });
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

    const messageExists = await scylla.execute(
      'SELECT message_id FROM messages WHERE conversation_id = ? AND message_id = ?',
      [convUuid, msgUuid],
      { prepare: true }
    );
    if (messageExists.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const state = await reactionState.set(storageConversationId, messageId, userId, emoji, present);
    const action = present ? 'add' : 'remove';

    const payload = {
      event_id: `reaction:${storageConversationId}:${messageId}:${state.revision}:${userId}`,
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId,
      emoji,
      user_id: userId,
      action,
      revision: state.revision,
      counts: state.counts,
      mine: state.mine,
    };

    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      // Include the actor's other tabs/devices. Absolute snapshots are safe
      // both for retries and for the optimistic originator receiving its echo.
      queueReactionEventToUser(memberId, payload);
    });

    res.json({ success: true, ...payload });
  } catch (err) {
    if (err instanceof ReactionError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.status === 425 ? { retryAfterMs: 250 } : {}) });
    console.error('Reaction state error:', err);
    res.status(503).json({ code: 'REACTION_UNAVAILABLE', error: 'Failed to update reaction', retryAfterMs: 500 });
  }
});

export default router;
