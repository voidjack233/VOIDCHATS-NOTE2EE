import { Router } from 'express';
import {
  batchFetchReactions,
  cassandra,
  mapStoredMessageRow,
  resolveConversationContexts,
  scylla,
  verifyMembership,
} from './shared.js';
import sentinel, { createSentinelKey } from '../../../sentinel/index.js';

const router = Router({ mergeParams: true });

router.get('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;
  const { before, after, limit } = req.query;
  const pageSize = Math.min(parseInt(limit, 10) || 50, 100);
  const visibleTargetSize = pageSize + 1;
  const fetchChunkSize = Math.min(Math.max(pageSize * 2, 50), 200);
  const maxFetchIterations = 12;

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) return res.status(404).json({ error: 'Conversation not found' });

    const {
      conversationId,
      conversationPublic,
      storageConversationId,
    } = resolvedConversation;
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

    let afterCursor = null;
    let beforeCursor = null;

    try {
      if (after) {
        afterCursor = cassandra.types.TimeUuid.fromString(String(after));
      }
      if (before) {
        beforeCursor = cassandra.types.TimeUuid.fromString(String(before));
      }
    } catch {
      return res.status(400).json({ error: 'Invalid before/after cursor' });
    }

    const seenMessageIds = new Set();
    const collectedVisibleMessages = [];
    let exhausted = false;
    let iterations = 0;

    while (collectedVisibleMessages.length < visibleTargetSize && !exhausted && iterations < maxFetchIterations) {
      iterations += 1;

      let query;
      let params;
      let queryMode;
      let queryCursor;

      if (afterCursor) {
        queryMode = 'after';
        queryCursor = afterCursor.toString();
        query = 'SELECT * FROM messages WHERE conversation_id = ? AND message_id > ? ORDER BY message_id ASC LIMIT ?';
        params = [
          cassandra.types.Uuid.fromString(storageConversationId),
          afterCursor,
          fetchChunkSize,
        ];
      } else if (beforeCursor) {
        queryMode = 'before';
        queryCursor = beforeCursor.toString();
        query = 'SELECT * FROM messages WHERE conversation_id = ? AND message_id < ? ORDER BY message_id DESC LIMIT ?';
        params = [
          cassandra.types.Uuid.fromString(storageConversationId),
          beforeCursor,
          fetchChunkSize,
        ];
      } else {
        queryMode = 'latest';
        queryCursor = null;
        query = 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY message_id DESC LIMIT ?';
        params = [cassandra.types.Uuid.fromString(storageConversationId), fetchChunkSize];
      }

      const flightKey = createSentinelKey(
        'scylla.messages.history',
        storageConversationId,
        queryMode,
        queryCursor,
        fetchChunkSize,
      );
      const result = await sentinel.guard(
        flightKey,
        () => scylla.execute(query, params, { prepare: true }),
      );
      const rows = result.rows || [];

      if (rows.length === 0) {
        exhausted = true;
        break;
      }

      const visibleChunk = rows.map((row) => mapStoredMessageRow(row, conversationPublic));

      for (const message of visibleChunk) {
        if (seenMessageIds.has(message.message_id)) continue;
        seenMessageIds.add(message.message_id);
        collectedVisibleMessages.push(message);
        if (collectedVisibleMessages.length >= visibleTargetSize) break;
      }

      if (rows.length < fetchChunkSize) {
        exhausted = true;
      }

      const lastRow = rows[rows.length - 1];
      if (!lastRow?.message_id) {
        exhausted = true;
      } else if (afterCursor) {
        afterCursor = lastRow.message_id;
      } else {
        beforeCursor = lastRow.message_id;
      }
    }

    const hasMore = collectedVisibleMessages.length > pageSize || (
      !exhausted &&
      iterations >= maxFetchIterations &&
      collectedVisibleMessages.length > 0
    );
    const pageMessages = collectedVisibleMessages.slice(0, pageSize);
    const visibleMessages = after
      ? [...pageMessages].reverse()
      : pageMessages;

    const messageIds = visibleMessages.map((message) => message.message_id);
    const reactions = await batchFetchReactions(storageConversationId, messageIds, userId);

    const messagesWithReactions = visibleMessages.map((message) => ({
      ...message,
      reactions: reactions[message.message_id] || {},
    }));

    res.json({
      success: true,
      messages: messagesWithReactions,
      has_more: hasMore,
    });
  } catch (err) {
    console.error('Message history error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

export default router;
