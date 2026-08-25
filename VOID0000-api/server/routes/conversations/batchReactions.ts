// server/routes/conversations/batchReactions.js

import { Router } from 'express';
import { pool } from '../../db.js';
import scylla, { cassandra } from '../../scylla.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { resolveMessageStorageConversation } from '../../utils/messageConversation.js';

const router = Router({ mergeParams: true });

type ReactionSummary = { count: number; me: boolean };
type ReactionBatch = Record<string, Record<string, ReactionSummary>>;

function normalizeReactionCount(value: unknown): number {
  if (value && typeof value === 'object') {
    const toNumber = Reflect.get(value, 'toNumber');
    if (typeof toNumber === 'function') {
      return Number(Reflect.apply(toNumber, value, []));
    }
  }
  return Number(value);
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
    conversationPublicId: conversation.public_id ? String(conversation.public_id) : null,
    storageConversationId: storageConversation?.id || conversation.id,
  };
}

// GET /api/conversations/:conversationId/reactions?message_ids=id1,id2,id3
router.get<{ conversationId: string }>('/', async (req, res) => {
  const userId = req.user?.id;
  const { conversationId: conversationIdentifier } = req.params;
  const { message_ids } = req.query;

  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!message_ids) {
    return res.status(400).json({ error: 'message_ids query param required' });
  }

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const {
      conversationId,
      conversationPublicId,
      storageConversationId,
    } = resolvedConversation;

    const memberCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const ids = String(message_ids).split(',').filter(Boolean).slice(0, 100);

    if (ids.length === 0) {
      return res.json({ success: true, reactions: {} });
    }

    const convUuid = cassandra.types.Uuid.fromString(storageConversationId);
    const userUuid = cassandra.types.Uuid.fromString(userId);

    const msgUuids = ids
      .map((id) => {
        try {
          return cassandra.types.TimeUuid.fromString(id);
        } catch {
          return null;
        }
      })
      .filter((value): value is cassandra.types.TimeUuid => value !== null);

    if (msgUuids.length === 0) {
      return res.json({
        success: true,
        conversation_id: conversationId,
        conversation_public_id: conversationPublicId,
        reactions: {},
      });
    }

    const [countsResult, meResult] = await Promise.all([
      scylla.execute(
        `SELECT message_id, emoji, count FROM reaction_counts
         WHERE conversation_id = ? AND message_id IN ?`,
        [convUuid, msgUuids],
        { prepare: true }
      ).catch(() => ({ rows: [] })),
      scylla.execute(
        `SELECT message_id, emoji FROM user_reactions
         WHERE conversation_id = ? AND user_id = ? AND message_id IN ?`,
        [convUuid, userUuid, msgUuids],
        { prepare: true }
      ).catch(() => ({ rows: [] })),
    ]);

    const meSet = new Set<string>();
    for (const row of meResult.rows) {
      meSet.add(`${row.message_id.toString()}:${row.emoji}`);
    }

    const reactions: ReactionBatch = {};
    for (const row of countsResult.rows) {
      const msgId = row.message_id.toString();
      const emoji = String(row.emoji);
      const count = normalizeReactionCount(row.count);

      if (count <= 0) continue;

      if (!reactions[msgId]) reactions[msgId] = {};
      reactions[msgId][emoji] = {
        count,
        me: meSet.has(`${msgId}:${emoji}`),
      };
    }

    res.json({
      success: true,
      conversation_id: conversationId,
      conversation_public_id: conversationPublicId,
      reactions,
    });
  } catch (err) {
    console.error('Batch reactions error:', err);
    res.status(500).json({ error: 'Failed to fetch reactions' });
  }
});

export default router;
