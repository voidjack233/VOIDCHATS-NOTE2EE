import { sendLiveEventToUser } from '../../../gateway/client.js';
import { canInteractInConversation } from '../../../utils/conversationInteraction.js';
import {
  AttachmentLifecycleError,
  attachmentLifecycle,
  createAttachmentReservationId,
  extractProtectedAttachmentIds,
  type AttachmentReservationResult,
} from '../../../attachments/lifecycle.js';
import {
  createAttachmentMessageConsistency,
  writeAttachmentMessageWithAcknowledgement,
} from '../../../attachments/messageConsistency.js';
import { dispatchMessagePushNotifications } from '../../../notifications/webPush.js';
import { messageEventId } from '../../../utils/eventIdentity.js';
import { debugLog } from '../../../utils/debugLog.js';
import { meetsWhoThreshold, resolvePermissions } from '../../../utils/groupPermissions.js';
import {
  attachSignedAttachmentUrls,
  createAttachmentDeliveryForQueryable,
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
import { claimMessageSend, SendOperationError, type MessageSendOperation } from './sendOperation.js';

export interface MessageSendErrorBody extends Record<string, unknown> {
  error?: string;
}

export class MessageSendError extends Error {
  readonly status: number;
  readonly body: MessageSendErrorBody;

  constructor(status: number, body: MessageSendErrorBody) {
    super(body?.error || 'Message send failed');
    this.status = status;
    this.body = body;
  }
}

export function isMessageSendError(error: unknown): error is MessageSendError {
  return error instanceof MessageSendError;
}

function fail(status: number, body: MessageSendErrorBody): never {
  throw new MessageSendError(status, body);
}

const MESSAGE_IDEMPOTENCY_TTL_SEC = 7 * 24 * 60 * 60;
const attachmentMessageConsistency = createAttachmentMessageConsistency({
  scyllaClient: scylla,
  cassandraDriver: cassandra,
});

function getClientMessageIdempotencyKey(
  userId: string,
  conversationId: string,
  clientMessageId: string,
): string {
  return `message:idempotency:${userId}:${conversationId}:${clientMessageId}`;
}

async function loadStoredMessage({
  conversationId,
  conversationPublic,
  storageConversationId,
  messageId,
  deliver = attachSignedAttachmentUrls,
}: {
  conversationId: string;
  conversationPublic: string | null;
  storageConversationId: string;
  messageId: string;
  deliver?: typeof attachSignedAttachmentUrls;
}) {
  const result = await attachmentMessageConsistency.read(
    `SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?`,
    [
      cassandra.types.Uuid.fromString(String(storageConversationId)),
      cassandra.types.TimeUuid.fromString(String(messageId)),
    ],
  );

  if (!result || typeof result !== 'object') {
    return null;
  }
  const rows = Reflect.get(result, 'rows');
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) {
    return null;
  }

  const storedMessage = mapStoredMessageRow(row, conversationPublic);
  const [message] = await deliver([{ ...storedMessage, conversation_id: conversationId }], conversationId);
  return message;
}

async function restoreIdempotentMessage({
  userId,
  conversationId,
  conversationPublic,
  storageConversationId,
  clientMessageId,
  deliver,
}: {
  userId: string;
  conversationId: string;
  conversationPublic: string | null;
  storageConversationId: string;
  clientMessageId: string | null;
  deliver: typeof attachSignedAttachmentUrls;
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

    const cached: unknown = JSON.parse(raw);
    const storedConversationId = cached && typeof cached === 'object'
      ? Reflect.get(cached, 'storageConversationId') || storageConversationId
      : storageConversationId;
    const storedMessageId = cached && typeof cached === 'object'
      ? Reflect.get(cached, 'messageId')
      : undefined;
    if (!storedMessageId || !storedConversationId) {
      throw new Error('Malformed legacy idempotency mapping');
    }
    if (String(storedConversationId) !== storageConversationId) throw new Error('Legacy storage identity mismatch');

    const message = await loadStoredMessage({
      conversationId,
      conversationPublic,
      storageConversationId: String(storedConversationId),
      messageId: String(storedMessageId),
      deliver,
    });
    if (!message) {
      throw new Error('Legacy message could not be recovered');
    }
    if (String(message.sender_id) !== userId) throw new Error('Legacy sender mismatch');

    return message;
  } catch (error) {
    console.warn('[MESSAGE_IDEMPOTENCY] failed to restore cached message', {
      conversation_id: conversationId,
      client_message_id: clientMessageId,
      error: error instanceof Error ? error.message : String(error || ''),
    });
    throw new SendOperationError(503, 'MESSAGE_RECOVERY_UNAVAILABLE', 'Message recovery is temporarily unavailable');
  }
}

export async function sendConversationMessage({
  userId,
  conversationIdentifier,
  body,
}: {
  userId: string;
  conversationIdentifier: unknown;
  body: unknown;
}) {
  const requestBody = body && typeof body === 'object' ? body : {};
  const {
    client_message_id,
    message_type,
    reply_to,
    attachments,
    content,
    forwarded,
    mentions,
    link_preview,
  } = {
    client_message_id: Reflect.get(requestBody, 'client_message_id'),
    message_type: Reflect.get(requestBody, 'message_type'),
    reply_to: Reflect.get(requestBody, 'reply_to'),
    attachments: Reflect.get(requestBody, 'attachments'),
    content: Reflect.get(requestBody, 'content'),
    forwarded: Reflect.get(requestBody, 'forwarded'),
    mentions: Reflect.get(requestBody, 'mentions'),
    link_preview: Reflect.get(requestBody, 'link_preview'),
  };
  let storageConversationUuid: cassandra.types.Uuid | null = null;
  let messageId: cassandra.types.TimeUuid | null = null;
  let attachmentReservation: AttachmentReservationResult | null = null;
  let ownsAttachmentReservation = false;
  let messageWriteAttempted = false;
  let messagePersistedToScylla = false;
  let postgresCommitAttempted = false;
  let messageAccepted = false;
  let operation: MessageSendOperation | undefined;

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
    if (!await canInteractInConversation(pool, conversation, userId)) fail(403, { error: 'You can only DM friends' });

    const normalizedClientMessageId =
      typeof client_message_id === 'string' && client_message_id.trim().length > 0
        ? client_message_id.trim().slice(0, 128)
        : null;

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
      fail(400, {
        error: metadataError instanceof Error
          ? metadataError.message
          : 'Invalid message metadata',
      });
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
    let replyToUuid: cassandra.types.TimeUuid | null = null;
    try {
      if (reply_to && typeof reply_to !== 'string') fail(400, { error: 'Invalid reply_to message id' });
      replyToUuid = reply_to ? cassandra.types.TimeUuid.fromString(reply_to) : null;
    } catch { fail(400, { error: 'Invalid reply_to message id' }); }

    if (normalizedClientMessageId) {
      operation = await claimMessageSend({
        dbPool: pool, userId, conversationId, storageConversationId,
        clientMessageId: normalizedClientMessageId, newMessageId: messageIdString,
        payload: { content: normalizedContent, message_type: message_type || 'text', reply_to: reply_to || null,
          attachments: normalizedAttachments, forwarded: normalizedForwarded, mentions: mentions ?? null, link_preview: link_preview ?? null },
        restoreLegacy: async client => {
          const legacy = await restoreIdempotentMessage({
            userId, conversationId, conversationPublic, storageConversationId, clientMessageId: normalizedClientMessageId,
            deliver: createAttachmentDeliveryForQueryable(client),
          });
          return legacy ? String(legacy.message_id) : null;
        },
      });
      messageIdString = operation.row.message_id;
      messageId = cassandra.types.TimeUuid.fromString(messageIdString);
    }
    const deliver = operation ? createAttachmentDeliveryForQueryable(operation.client) : attachSignedAttachmentUrls;
    storageConversationUuid = cassandra.types.Uuid.fromString(storageConversationId);
    let recoveredRow: cassandra.types.Row | undefined;
    if (operation && (operation.resumed || operation.row.completed_at)) {
      const result = await attachmentMessageConsistency.read(
        'SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?', [storageConversationUuid, messageId],
      ) as { rows?: cassandra.types.Row[] };
      if (!Array.isArray(result?.rows) || result.rows.length > 1) throw new Error('Malformed message recovery result');
      recoveredRow = result.rows[0];
      if (recoveredRow && (String(recoveredRow.sender_id) !== userId || String(recoveredRow.message_id) !== messageIdString)) {
        throw new Error('Stored message identity mismatch');
      }
      if (operation.row.completed_at && !recoveredRow) {
        fail(503, { code: 'MESSAGE_RECOVERY_UNAVAILABLE', error: 'Accepted message is temporarily unavailable' });
      }
      messageAccepted = Boolean(operation.row.completed_at);
    }

    if (!messageAccepted) attachmentReservation = await attachmentLifecycle.reserveForMessage({
      attachmentIds,
      userId,
      conversationId,
      reservationId,
      messageId: messageIdString,
    }, operation?.client);

    if (attachmentReservation?.state === 'committed' && !operation) {
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

    if (attachmentReservation?.state === 'reserved' && !operation) {
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

    if (operation && attachmentReservation && attachmentReservation.messageId !== messageIdString) {
      fail(409, { code: 'ATTACHMENT_COMMIT_RECOVERY_REQUIRED', error: 'Reservation belongs to a different message' });
    }
    if (operation && attachmentReservation?.state === 'committed' && !recoveredRow) {
      fail(503, { code: 'MESSAGE_RECOVERY_UNAVAILABLE', error: 'Committed attachment message is unavailable' });
    }
    ownsAttachmentReservation = attachmentReservation?.state === 'reserved_new';
    const activeReservation = attachmentReservation;
    messageIdString = attachmentReservation?.messageId ?? messageIdString;
    messageId = cassandra.types.TimeUuid.fromString(messageIdString);
    const now = operation ? new Date(operation.row.created_at) : new Date();

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
    const insertQuery = `INSERT INTO messages (
        conversation_id, message_id, sender_id, content,
        message_type, reply_to, attachments, forwarded, mentions, link_preview, is_edited, is_deleted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, false, ?)`;
    if (!messageAccepted && !recoveredRow) {
      messageWriteAttempted = true;
      if (attachmentIds.length > 0 && activeReservation) {
        await writeAttachmentMessageWithAcknowledgement({
          insertMessage: () => attachmentMessageConsistency.insert(insertQuery, messageInsertParams),
          onInsertSucceeded: () => { messagePersistedToScylla = true; },
          acknowledgeReservation: () => attachmentLifecycle.acknowledgeScyllaWrite(activeReservation, operation?.client),
        });
      } else {
        if (operation) await attachmentMessageConsistency.insert(insertQuery, messageInsertParams);
        else await scylla.execute(insertQuery, messageInsertParams, { prepare: true });
        messagePersistedToScylla = true;
      }
    }

    const touchedConversationIds = [...new Set(
      [conversationId, storageConversationId, conversation.parent_conversation_id].filter(Boolean)
    )];

    if (!messageAccepted) {
      const pgClient = operation?.client ?? await pool.connect();
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
        if (activeReservation) {
          if (recoveredRow) await attachmentLifecycle.commitRecoveredReservation(pgClient, activeReservation, {
            sender_id: recoveredRow.sender_id, message_id: recoveredRow.message_id, attachments: recoveredRow.attachments,
          });
          else await attachmentLifecycle.commitReservation(pgClient, activeReservation);
        }
        await operation?.complete();

        postgresCommitAttempted = true;
        await pgClient.query('COMMIT');
        messageAccepted = true;
      } catch (pgErr) {
        await pgClient.query('ROLLBACK').catch(() => {});
        throw pgErr;
      } finally {
        if (!operation) pgClient.release();
      }
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
    const [messageForDelivery] = await deliver([recoveredRow ? {
      ...mapStoredMessageRow(recoveredRow, conversationPublic), conversation_id: conversationId,
      event_id: messageEventId(messageIdString), client_message_id: normalizedClientMessageId,
    } : message], conversationId);

    if (operation?.row.effects_scheduled_at) return { message: messageForDelivery };

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

    const members = await getConversationMembers(conversationId, operation?.client);
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
    await operation?.effectsScheduled();

    return { message: messageForDelivery };
  } catch (err) {
    let scyllaRollbackConfirmed = false;
    if (
      !messageAccepted &&
      !operation &&
      messagePersistedToScylla &&
      storageConversationUuid &&
      messageId &&
      !postgresCommitAttempted
    ) {
      try {
        await attachmentMessageConsistency.remove(
          'DELETE FROM messages WHERE conversation_id = ? AND message_id = ?',
          [storageConversationUuid, messageId],
        );
        scyllaRollbackConfirmed = true;
      } catch (cleanupErr) {
        console.error('Failed to roll back Scylla message after send error:', cleanupErr);
      }
    }

    const canReleaseReservation =
      ownsAttachmentReservation &&
      !operation &&
      attachmentReservation &&
      !messageAccepted &&
      (
        !messageWriteAttempted ||
        scyllaRollbackConfirmed
      );
    if (canReleaseReservation && attachmentReservation) {
      await attachmentLifecycle.releaseReservation(attachmentReservation).catch((releaseError) => {
        console.error('Failed to release attachment reservation after send error:', releaseError);
      });
    }

    if (err instanceof AttachmentLifecycleError) {
      throw new MessageSendError(err.status, err.body);
    }
    if (err instanceof SendOperationError) throw new MessageSendError(err.status, { error: err.message, code: err.code, retryAfterMs: 500 });
    throw err;
  } finally {
    await operation?.close();
  }
}
