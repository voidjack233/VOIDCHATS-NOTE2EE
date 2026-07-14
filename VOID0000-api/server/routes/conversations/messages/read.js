import { Router } from 'express';
import {
  cassandra,
  conversationPublicId,
  pool,
  resolveConversationContexts,
  verifyMembership,
} from './shared.js';

const router = Router({ mergeParams: true });

router.put('/read', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;
  const { message_id } = req.body;

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) return res.status(404).json({ error: 'Conversation not found' });

    const {
      conversation,
      storageConversationId,
    } = resolvedConversation;
    const membershipConversationId = conversation.parent_conversation_id || conversation.id;
    const member = await verifyMembership(membershipConversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

    let parsedMessageId = null;
    if (message_id) {
      try {
        parsedMessageId = cassandra.types.TimeUuid.fromString(String(message_id));
      } catch {
        return res.status(400).json({ error: 'Invalid message_id' });
      }

      void parsedMessageId;
    }

    await pool.query(
      `UPDATE conversation_members
       SET last_read_message_id = $1,
           unread_count = 0
       WHERE conversation_id = $2 AND user_id = $3`,
      [message_id || null, membershipConversationId, userId]
    );

    res.json({
      success: true,
      conversation_id: conversation.id,
      conversation_public_id: conversationPublicId(conversation),
    });
  } catch (err) {
    console.error('Read receipt error:', err);
    res.status(500).json({ error: 'Failed to update read receipt' });
  }
});

export default router;
