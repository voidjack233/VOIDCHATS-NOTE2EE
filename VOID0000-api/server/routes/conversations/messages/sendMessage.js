import { sendLiveEventToUser } from '../../../gateway/client.js';
import {
  AttachmentLifecycleError,
  attachmentLifecycle,
  createAttachmentReservationId,
  extractProtectedAttachmentIds,
} from '../../../attachments/lifecycle.js';
import { dispatchMessagePushNotifications } from '../../../notifications/webPush.js';
import { messageEventId } from '../../../utils/eventIdentity.js';
import { debugLog } from '../../../utils/debugLog.js';
import { emitConversationUpdate } from '../../../utils/groupMembership.js';
import { meetsWhoThreshold, resolvePermissions } from '../../../utils/groupPermissions.js';
import {
  attachSignedAttachmentUrls,
  normalizeStoredAttachments,
} from '../../../utils/attachmentDelivery.js';
import {
  cassandra,
  getConversationMembers,
  mapStoredMessageRow,
  normalizeForwardedMetadata,
  normalizeMentionMetadata,
  pool,
  resolveConversationContexts,
  scylla,
  serializeStoredMessageMetadata,
  verifyMembership,
} from './shared.js';
import valkey from '../../../valkey.js';

export class MessageSendError extends Error {
  constructor(status, body) {
    super(body?.error || 'Message send failed');
    this.status = status;
    this.body = body;
  }
}

export function isMessageSendError(error) {
  return error instanceof MessageSendError;
}

function fail(status, body) {
  throw new MessageSendError(status, body);
}

const MESSAGE_IDEMPOTENCY_TTL_SEC = 7 * 24 * 60 * 60;

function getClientMessageIdempotencyKey(userId, conversationId, clientMessageId) {
  return `message:idempotency:${userId}:${conversationId}:${clientMessageId}`;
}

async function loadStoredMessage({
  conversationId,
  conversationPublic,
  storageConversationId,
  messageId,
}) {
  const result = await scylla.execute(
    `SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?`,
    [
      cassandra.types.Uuid.fromString(String(storageConversationId)),
      cassandra.types.TimeUuid.fromString(String(messageId)),
    ],
    { prepare: true }
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const storedMessage = mapStoredMessageRow(row, conversationPublic);
  const [message] = await attachSignedAttachmentUrls([storedMessage], conversationId);
  return message;
}

async function restoreIdempotentMessage({
  userId,
  conversationId,
  conversationPublic,
  storageConversationId,
  clientMessageId,
}) {
  if (!clientMessageId) {
    return null;
  }

  try {
    const raw = await valkey.get(
      getClientMessageIdempotencyKey(userId, conversationId, clientMessageId)
    );
    if (!raw) {
      return null;
    }

    const cached = JSON.parse(raw);
    const storedConversationId = cached?.storageConversationId || storageConversationId;
    const storedMessageId = cached?.messageId;
    if (!storedMessageId || !storedConversationId) {
      return null;
    }

    const message = await loadStoredMessage({
      conversationId,
      conversationPublic,
      storageConversationId: storedConversationId,
      messageId: storedMessageId,
    });
    if (!message) {
      await valkey.del(
        getClientMessageIdempotencyKey(userId, conversationId, clientMessageId)
      ).catch(() => {});
      return null;
    }

    return message;
  } catch (error) {
    console.warn('[MESSAGE_IDEMPOTENCY] failed to restore cached message', {
      conversation_id: conversationId,
      client_message_id: clientMessageId,
      error: error instanceof Error ? error.message : String(error || ''),
    });
    return null;
  }
}

export async function sendConversationMessage({ userId, conversationIdentifier, body }) {
  const {
    client_message_id,
    message_type,
    reply_to,
    attachments,
    content,
    forwarded,
    mentions,
    link_preview,
  } = body || {};
  let storageConversationUuid = null;
  let messageId = null;
  let attachmentReservation = null;
  let ownsAttachmentReservation = false;
  let messageWriteAttempted = false;
  let messagePersistedToScylla = false;
  let postgresCommitAttempted = false;
  let messageAccepted = false;

  const normalizedContent = typeof content === 'string' ? content.trim() : '';
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

  if (!normalizedContent && !hasAttachments) {
    fail(400, { error: 'Message content or attachments required' });
  }

  if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 5)) {
    fail(400, { error: 'attachments must be an array of up to 5 URLs' });
  }

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) fail(404, { error: 'Conversation not found' });

    const {
      conversation,
      conversationId,
      conversationPublic,
      storageConversationId,
    } = resolvedConversation;
    const membershipConversationId = conversation.parent_conversation_id || conversationId;
    const member = await verifyMembership(conversationId, userId);
    if (!member) fail(403, { error: 'Not a member of this conversation' });
    if (member.role === 'viewer') fail(403, { error: 'Viewers cannot send messages' });

    const normalizedClientMessageId =
      typeof client_message_id === 'string' && client_message_id.trim().length > 0
        ? client_message_id.trim().slice(0, 128)
        : null;

    if (normalizedClientMessageId) {
      const existingMessage = await restoreIdempotentMessage({
        userId,
        conversationId,
        conversationPublic,
        storageConversationId,
        clientMessageId: normalizedClientMessageId,
      });

      if (existingMessage) {
        return { message: existingMessage };
      }
    }

    if ((conversation.type === 'group' || conversation.type === 'channel') && Array.isArray(attachments) && attachments.length > 0) {
      let permissionsSource = conversation.permissions;
      if (conversation.type === 'channel' && conversation.parent_conversation_id) {
        const parentResult = await pool.query(
          'SELECT permissions FROM conversations WHERE id = $1 LIMIT 1',
          [conversation.parent_conversation_id]
        );
        if (parentResult.rows.length > 0) {
          permissionsSource = parentResult.rows[0].permissions;
        }
      }
      const perms = resolvePermissions(permissionsSource);
      if (!meetsWhoThreshold(member.role, perms.who_can_send_attachments)) {
        fail(403, { error: 'You do not have permission to send attachments' });
      }
    }

    let normalizedForwarded;
    let normalizedMentions;
    try {
      normalizedForwarded = normalizeForwardedMetadata(forwarded);
      normalizedMentions = await normalizeMentionMetadata(conversationId, conversation.type, mentions);
    } catch (metadataError) {
      fail(400, { error: metadataError.message || 'Invalid message metadata' });
    }

    const normalizedAttachments = normalizeStoredAttachments(attachments);
    const attachmentIds = hasAttachments
      ? extractProtectedAttachmentIds(attachments)
      : [];
    if (normalizedAttachments.length !== attachmentIds.length) {
      fail(400, {
        error: 'One or more attachment descriptors are invalid',
        code: 'ATTACHMENT_REFERENCE_INVALID',
      });
    }
    const attachList = normalizedAttachments.length > 0 ? normalizedAttachments : null;
    const storedForwarded = serializeStoredMessageMetadata(normalizedForwarded);
    const storedMentions = serializeStoredMessageMetadata(normalizedMentions);
    const storedLinkPreview = serializeStoredMessageMetadata(link_preview);

    messageId = cassandra.types.TimeUuid.now();
    let messageIdString = messageId.toString();
    const reservationId = createAttachmentReservationId(normalizedClientMessageId);

    attachmentReservation = await attachmentLifecycle.reserveForMessage({
      attachmentIds,
      userId,
      conversationId,
      reservationId,
      messageId: messageIdString,
    });

    if (attachmentReservation.state === 'committed') {
      const existingMessage = await loadStoredMessage({
        conversationId,
        conversationPublic,
        storageConversationId,
        messageId: attachmentReservation.messageId,
      });
      if (!existingMessage) {
        fail(409, {
          error: 'The committed attachment message could not be recovered',
          code: 'ATTACHMENT_COMMIT_RECOVERY_REQUIRED',
        });
      }
      return { message: existingMessage };
    }

    if (attachmentReservation.state === 'reserved') {
      if (attachmentReservation.reservationExpired) {
        fail(409, {
          error: 'This attachment is held for safe message reconciliation. Upload it again to retry.',
          code: 'ATTACHMENT_RESERVATION_RECOVERY_REQUIRED',
        });
      }
      fail(425, {
        error: 'This attachment message is already being processed',
        code: 'ATTACHMENT_RESERVATION_IN_PROGRESS',
        retryAfterMs: 500,
      });
    }

    ownsAttachmentReservation = attachmentReservation.state === 'reserved_new';
    messageIdString = attachmentReservation.messageId;
    messageId = cassandra.types.TimeUuid.fromString(messageIdString);
    const now = new Date();
    storageConversationUuid = cassandra.types.Uuid.fromString(storageConversationId);
    let replyToUuid = null;
    try {
      replyToUuid = reply_to ? cassandra.types.TimeUuid.fromString(reply_to) : null;
    } catch {
      fail(400, { error: 'Invalid reply_to message id' });
    }

    const messageInsertParams = [
      storageConversationUuid,
      messageId,
      cassandra.types.Uuid.fromString(userId),
      normalizedContent,
      message_type || 'text',
      replyToUuid,
      attachList,
      storedForwarded,
      storedMentions,
      storedLinkPreview,
      now,
    ];
    messageWriteAttempted = true;
    await scylla.execute(
      `INSERT INTO messages (
        conversation_id, message_id, sender_id, content,
        message_type, reply_to, attachments, forwarded, mentions, link_preview, is_edited, is_deleted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, false, ?)`,
      messageInsertParams,
      { prepare: true }
    );
    messagePersistedToScylla = true;

    const touchedConversationIds = [...new Set(
      [conversationId, storageConversationId, conversation.parent_conversation_id].filter(Boolean)
    )];

    const pgClient = await pool.connect();
    try {
      await pgClient.query('BEGIN');

      await pgClient.query(
        `UPDATE conversations
         SET updated_at = NOW(),
             first_message_at = COALESCE(first_message_at, NOW())
         WHERE id = ANY($1::uuid[])`,
        [touchedConversationIds]
      );
      await pgClient.query(
        `UPDATE conversation_members
         SET unread_count = CASE
               WHEN user_id = $2 THEN 0
               ELSE COALESCE(unread_count, 0) + 1
             END,
             last_read_message_id = CASE
               WHEN user_id = $2 THEN $3
               ELSE last_read_message_id
             END,
             last_message_sent_at = CASE
               WHEN user_id = $2 THEN NOW()
               ELSE last_message_sent_at
             END
         WHERE conversation_id = $1`,
        [membershipConversationId, userId, messageIdString]
      );
      await attachmentLifecycle.commitReservation(pgClient, attachmentReservation);

      postgresCommitAttempted = true;
      await pgClient.query('COMMIT');
      messageAccepted = true;
    } catch (pgErr) {
      await pgClient.query('ROLLBACK');
      throw pgErr;
    } finally {
      pgClient.release();
    }

    const message = {
      event_id: messageEventId(messageId.toString()),
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageIdString,
      client_message_id: normalizedClientMessageId,
      sender_id: userId,
      content: normalizedContent,
      message_type: message_type || 'text',
      reply_to: reply_to || null,
      attachments: attachList || [],
      forwarded: normalizedForwarded || null,
      mentions: normalizedMentions,
      link_preview: link_preview || null,
      is_edited: false,
      is_deleted: false,
      created_at: now.toISOString(),
    };
    const [messageForDelivery] = await attachSignedAttachmentUrls([message], conversationId);

    if (normalizedClientMessageId) {
      await valkey.set(
        getClientMessageIdempotencyKey(userId, conversationId, normalizedClientMessageId),
        JSON.stringify({
          storageConversationId,
          messageId: messageIdString,
        }),
        'EX',
        MESSAGE_IDEMPOTENCY_TTL_SEC,
      ).catch((error) => {
        console.warn('[MESSAGE_IDEMPOTENCY] failed to cache sent message mapping', {
          conversation_id: conversationId,
          client_message_id: normalizedClientMessageId,
          error: error instanceof Error ? error.message : String(error || ''),
        });
      });
    }

    const members = await getConversationMembers(conversationId);
    debugLog('[WS_FANOUT] MESSAGE_CREATE', {
      conversation_id: conversationId,
      sender_id: userId,
      recipient_count: members.length,
      includes_sender_sessions: true,
    });
    members.forEach((memberId) => {
      sendLiveEventToUser(memberId, 'MESSAGE_CREATE', messageForDelivery);
    });
    void dispatchMessagePushNotifications({
      senderId: userId,
      recipientIds: members,
      conversation,
      mentions: normalizedMentions,
    });

    return { message: messageForDelivery };
  } catch (err) {
    let scyllaRollbackConfirmed = false;
    if (
      !messageAccepted &&
      messagePersistedToScylla &&
      storageConversationUuid &&
      messageId &&
      (!postgresCommitAttempted || !ownsAttachmentReservation)
    ) {
      try {
        await scylla.execute(
          'DELETE FROM messages WHERE conversation_id = ? AND message_id = ?',
          [storageConversationUuid, messageId],
          { prepare: true }
        );
        scyllaRollbackConfirmed = true;
      } catch (cleanupErr) {
        console.error('Failed to roll back Scylla message after send error:', cleanupErr);
      }
    }

    const canReleaseReservation =
      ownsAttachmentReservation &&
      attachmentReservation &&
      !messageAccepted &&
      (
        !messageWriteAttempted ||
        scyllaRollbackConfirmed
      );
    if (canReleaseReservation) {
      await attachmentLifecycle.releaseReservation(attachmentReservation).catch((releaseError) => {
        console.error('Failed to release attachment reservation after send error:', releaseError);
      });
    }

    if (err instanceof AttachmentLifecycleError) {
      throw new MessageSendError(err.status, err.body);
    }
    throw err;
  }
}
