import { Router } from 'express';
import { pool } from '../../db.js';
import { cassandra } from '../../scylla.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { resolveMessageStorageConversation } from '../../utils/messageConversation.js';
import { reactionState } from '../../reactions/index.js';

const router = Router({ mergeParams: true });

router.get<{ conversationId: string }>('/', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  if (!req.query.message_ids) return res.status(400).json({ error: 'message_ids query param required' });
  try {
    const conversation = await findConversationByIdentifier(req.params.conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    const storage = await resolveMessageStorageConversation(conversation);
    const member = await pool.query('SELECT role FROM conversation_members WHERE conversation_id=$1 AND user_id=$2', [conversation.id, userId]);
    if (!member.rows.length) return res.status(403).json({ error: 'Not a member of this conversation' });
    const ids = String(req.query.message_ids).split(',').filter(Boolean).slice(0, 100).filter(id => {
      try { cassandra.types.TimeUuid.fromString(id); return true; } catch { return false; }
    });
    const data = await reactionState.batch(storage?.id || conversation.id, ids, userId);
    return res.json({ success: true, conversation_id: conversation.id, conversation_public_id: conversation.public_id, ...data });
  } catch (error) {
    console.error('Batch reactions error:', error);
    return res.status(503).json({ error: 'Failed to fetch reactions' });
  }
});

export default router;
