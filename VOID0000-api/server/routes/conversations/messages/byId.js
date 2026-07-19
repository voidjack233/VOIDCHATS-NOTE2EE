import { Router } from 'express';
import { sendLiveEventToUser } from '../../../gateway/client.js';
import { debugLog } from '../../../utils/debugLog.js';
import {
  attachSignedAttachmentUrls,
  normalizeStoredAttachments,
} from '../../../utils/attachmentDelivery.js';
import {
  batchFetchReactions,
  cassandra,
  getConversationMembers,
  mapStoredMessageRow,
  normalizeForwardedMetadata,
  normalizeMentionMetadata,
  serializeStoredMessageMetadata,
  resolveConversationContexts,
  scylla,
  verifyMembership,
} from './shared.js';

const router = Router({ mergeParams: true });
const DEFAULT_CONTEXT_LIMIT = 30;
const MAX_CONTEXT_LIMIT = 50;

function clampContextLimit(value) {
  const parsed = parseInt(String(value ?? DEFAULT_CONTEXT_LIMIT), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_CONTEXT_LIMIT;
  }
  return Math.min(parsed, MAX_CONTEXT_LIMIT);
}

function compareMessagesByCreatedAtAsc(left, right) {
  const timeDiff = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
  if (timeDiff !== 0) return timeDiff;
  return String(left.message_id).localeCompare(String(right.message_id));
}

async function fetchVisibleContextSide({
  storageConversationId,
  conversationPublic,
  cursor,
  direction,
  limit,
}) {
  if (limit <= 0) {
    return { messages: [], hasMore: false };
  }

  const conversationUuid = cassandra.types.Uuid.fromString(storageConversationId);
  const collectedMessages = [];
  const fetchChunkSize = Math.min(Math.max((limit + 1) * 2, 50), 120);
  const maxFetchIterations = 8;
  let nextCursor = cursor;
  let exhausted = false;
  let iterations = 0;

  while (collectedMessages.length <= limit && !exhausted && iterations < maxFetchIterations) {
    iterations += 1;

    const isNewer = direction === 'newer';
    const result = await scylla.execute(
      isNewer
        ? 'SELECT * FROM messages WHERE conversation_id = ? AND message_id > ? ORDER BY message_id ASC LIMIT ?'
        : 'SELECT * FROM messages WHERE conversation_id = ? AND message_id < ? ORDER BY message_id DESC LIMIT ?',
      [conversationUuid, nextCursor, fetchChunkSize],
      { prepare: true }
    );

    const rows = result.rows || [];
    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    collectedMessages.push(...rows.map((row) => mapStoredMessageRow(row, conversationPublic)));

    if (rows.length < fetchChunkSize) {
      exhausted = true;
    }

    const lastRow = rows[rows.length - 1];
    if (!lastRow?.message_id) {
      exhausted = true;
    } else {
      nextCursor = lastRow.message_id;
    }
  }

  const limitedMessages = collectedMessages.slice(0, limit);
  return {
    messages: direction === 'older'
      ? limitedMessages.reverse()
      : limitedMessages,
    hasMore: collectedMessages.length > limit,
  };
}

router.get('/:messageId/context', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;
  const beforeLimit = clampContextLimit(req.query.before);
  const afterLimit = clampContextLimit(req.query.after);

  let targetMessageId;
  try {
    targetMessageId = cassandra.types.TimeUuid.fromString(String(messageId));
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid message id' });
  }

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) return res.status(404).json({ success: false, error: 'Conversation not found' });

    const {
      conversationId,
      conversationPublic,
      storageConversationId,
    } = resolvedConversation;
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ success: false, error: 'Not a member of this conversation' });

    const targetResult = await scylla.execute(
      `SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(storageConversationId), targetMessageId],
      { prepare: true }
    );

    if (targetResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    const targetMessage = mapStoredMessageRow(targetResult.rows[0], conversationPublic);

    const [olderContext, newerContext] = await Promise.all([
      fetchVisibleContextSide({
        storageConversationId,
        conversationPublic,
        cursor: targetMessageId,
        direction: 'older',
        limit: beforeLimit,
      }),
      fetchVisibleContextSide({
        storageConversationId,
        conversationPublic,
        cursor: targetMessageId,
        direction: 'newer',
        limit: afterLimit,
      }),
    ]);

    const uniqueMessagesById = new Map();
    [...olderContext.messages, targetMessage, ...newerContext.messages].forEach((message) => {
      uniqueMessagesById.set(message.message_id, message);
    });
    const contextMessages = Array.from(uniqueMessagesById.values())
      .sort(compareMessagesByCreatedAtAsc);
    const messageIds = contextMessages.map((message) => message.message_id);
    const reactions = await batchFetchReactions(storageConversationId, messageIds, userId);

    const messagesWithReactions = contextMessages.map((message) => ({
      ...message,
      reactions: reactions[message.message_id] || {},
    }));
    const messagesWithSignedAttachments = await attachSignedAttachmentUrls(
      messagesWithReactions,
      conversationId,
    );

    res.json({
      success: true,
      target_message_id: String(messageId),
      messages: messagesWithSignedAttachments,
      has_older: olderContext.hasMore,
      has_newer: newerContext.hasMore,
    });
  } catch (err) {
    console.error('Message context fetch error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch message context' });
  }
});

router.get('/:messageId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;

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

    const result = await scylla.execute(
      `SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(storageConversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Message not found' });

    const storedMessage = mapStoredMessageRow(result.rows[0], conversationPublic);
    const [message] = await attachSignedAttachmentUrls([storedMessage], conversationId);

    res.json({ success: true, message });
  } catch (err) {
    console.error('Single message fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch message' });
  }
});

router.patch('/:messageId/preview', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;
  const { link_preview } = req.body || {};

  if (!link_preview || typeof link_preview !== 'object') {
    return res.status(400).json({ error: 'link_preview is required' });
  }

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) return res.status(404).json({ error: 'Conversation not found' });

    const {
      conversationId,
      conversationPublic,
      storageConversationId,
    } = resolvedConversation;
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const messageResult = await scylla.execute(
      `SELECT sender_id, is_deleted FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(storageConversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (messageResult.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    const messageRow = messageResult.rows[0];
    if (messageRow.sender_id.toString() !== userId) {
      return res.status(403).json({ error: 'Can only update previews for your own messages' });
    }
    if (messageRow.is_deleted) return res.status(400).json({ error: 'Cannot update a deleted message' });

    await scylla.execute(
      `UPDATE messages SET link_preview = ?
       WHERE conversation_id = ? AND message_id = ?`,
      [
        serializeStoredMessageMetadata(link_preview),
        cassandra.types.Uuid.fromString(storageConversationId),
        cassandra.types.TimeUuid.fromString(messageId),
      ],
      { prepare: true }
    );

    const update = {
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId,
      link_preview,
    };

    const members = await getConversationMembers(conversationId);
    debugLog('[WS_FANOUT] MESSAGE_UPDATE preview', {
      conversation_id: conversationId,
      sender_id: userId,
      recipient_count: members.length,
      includes_sender_sessions: true,
    });
    members.forEach((memberId) => {
      sendLiveEventToUser(memberId, 'MESSAGE_UPDATE', update);
    });

    res.json({ success: true, ...update });
  } catch (err) {
    console.error('Message preview update error:', err);
    res.status(500).json({ error: 'Failed to update message preview' });
  }
});

router.put('/:messageId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;
  const { content, message_type, attachments, forwarded, mentions, link_preview } = req.body;

  if (typeof content !== 'string' || (!content.trim() && (!Array.isArray(attachments) || attachments.length === 0))) {
    return res.status(400).json({ error: 'Message content or attachments required' });
  }

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) return res.status(404).json({ error: 'Conversation not found' });

    const {
      conversation,
      conversationId,
      conversationPublic,
      storageConversationId,
    } = resolvedConversation;
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    let normalizedForwarded;
    let normalizedMentions;
    try {
      normalizedForwarded = normalizeForwardedMetadata(forwarded);
      normalizedMentions = await normalizeMentionMetadata(conversationId, conversation.type, mentions);
    } catch (metadataError) {
      return res.status(400).json({ error: metadataError.message || 'Invalid message metadata' });
    }

    const messageResult = await scylla.execute(
      `SELECT sender_id, is_deleted, message_type FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(storageConversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (messageResult.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    const messageRow = messageResult.rows[0];
    if (messageRow.sender_id.toString() !== userId) {
      return res.status(403).json({ error: 'Can only edit your own messages' });
    }
    if (messageRow.is_deleted) return res.status(400).json({ error: 'Cannot edit a deleted message' });
    const nextMessageType = typeof message_type === 'string' && message_type.trim()
      ? message_type.trim()
      : (messageRow.message_type || 'text');
    const storedForwarded = serializeStoredMessageMetadata(normalizedForwarded);
    const storedMentions = serializeStoredMessageMetadata(normalizedMentions);
    const storedLinkPreview = serializeStoredMessageMetadata(link_preview);
    const normalizedAttachments = normalizeStoredAttachments(attachments);
    const attachList = normalizedAttachments.length > 0 ? normalizedAttachments : null;
    const normalizedContent = content.trim();

    const now = new Date();

    await scylla.execute(
      `UPDATE messages SET content = ?, message_type = ?, attachments = ?, forwarded = ?, mentions = ?, link_preview = ?,
         is_edited = true, edited_at = ?
       WHERE conversation_id = ? AND message_id = ?`,
      [
        normalizedContent,
        nextMessageType,
        attachList,
        storedForwarded,
        storedMentions,
        storedLinkPreview,
        now,
        cassandra.types.Uuid.fromString(storageConversationId),
        cassandra.types.TimeUuid.fromString(messageId),
      ],
      { prepare: true }
    );

    const update = {
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId,
      content: normalizedContent,
      message_type: nextMessageType,
      attachments: attachList || [],
      forwarded: normalizedForwarded || null,
      mentions: normalizedMentions,
      link_preview: link_preview || null,
      is_edited: true,
      edited_at: now.toISOString(),
    };
    const [updateForDelivery] = await attachSignedAttachmentUrls([update], conversationId);

    const members = await getConversationMembers(conversationId);
    debugLog('[WS_FANOUT] MESSAGE_UPDATE', {
      conversation_id: conversationId,
      sender_id: userId,
      recipient_count: members.length,
      includes_sender_sessions: true,
    });
    members.forEach((memberId) => {
      sendLiveEventToUser(memberId, 'MESSAGE_UPDATE', updateForDelivery);
    });

    res.json({ success: true, ...updateForDelivery });
  } catch (err) {
    console.error('Message edit error:', err);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

router.delete('/:messageId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) return res.status(404).json({ error: 'Conversation not found' });

    const {
      conversationId,
      conversationPublic,
      storageConversationId,
    } = resolvedConversation;
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const messageResult = await scylla.execute(
      `SELECT sender_id FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(storageConversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (messageResult.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    const isSender = messageResult.rows[0].sender_id.toString() === userId;
    const canDelete = isSender || ['owner', 'admin'].includes(member.role);
    if (!canDelete) return res.status(403).json({ error: 'Cannot delete this message' });

    await scylla.execute(
      `UPDATE messages SET is_deleted = true, content = null, link_preview = null
       WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(storageConversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    const deletion = {
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId,
      deleted_by: userId,
    };

    const members = await getConversationMembers(conversationId);
    debugLog('[WS_FANOUT] MESSAGE_DELETE', {
      conversation_id: conversationId,
      sender_id: userId,
      recipient_count: members.length,
      includes_sender_sessions: true,
    });
    members.forEach((memberId) => {
      sendLiveEventToUser(memberId, 'MESSAGE_DELETE', deletion);
    });

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    console.error('Message delete error:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

export default router;
