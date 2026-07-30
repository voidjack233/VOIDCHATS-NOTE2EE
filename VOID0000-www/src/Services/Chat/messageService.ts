import { fetchWithAuth } from '../Auth/authServiceApi';
import { prepareAttachmentFile, resolveAttachmentBlob } from './attachmentService';
import { parseAttachment, serializeAttachment } from './messageAttachments';
import type {
  Conversation,
  ForwardedMessageMetadata,
  LinkPreviewMetadata,
  Message,
  MessageMentionMetadata,
} from './chatTypes';
import { CHAT_API_PREFIX, createApiError, getRetryAfterMsFromResponse } from './chatUtils';

export { parseAttachment, parseAttachments } from './messageAttachments';

const MESSAGE_SEND_TIMEOUT_MS = 30_000;
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;

async function withRequestTimeout<T>(
  timeoutMs: number,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new Error(`${label} timed out. Check your connection and retry.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function normalizeMessage(raw: Partial<Message>): Message {
  return {
    conversation_id: String(raw.conversation_id || ''),
    message_id: String(raw.message_id || ''),
    sender_id: String(raw.sender_id || ''),
    content: raw.is_deleted ? '[deleted]' : String(raw.content || ''),
    message_type: raw.message_type || 'text',
    reply_to: raw.reply_to || null,
    is_edited: Boolean(raw.is_edited),
    edited_at: raw.edited_at || null,
    is_deleted: Boolean(raw.is_deleted),
    created_at: raw.created_at || new Date().toISOString(),
    ...raw,
  } as Message;
}

interface SendOptions {
  client_message_id?: string;
  reply_to?: string;
  attachments?: string[];
  message_type?: string;
  forwarded?: ForwardedMessageMetadata | null;
  mentions?: MessageMentionMetadata[] | null;
  linkPreview?: LinkPreviewMetadata | null;
}

export async function sendMessage(
  conversationId: string,
  content: string,
  options?: SendOptions,
): Promise<Message> {
  const { response, data } = await withRequestTimeout(MESSAGE_SEND_TIMEOUT_MS, 'Message send', async (signal) => {
    const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages`, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        content,
        message_type: options?.message_type || 'text',
        client_message_id: options?.client_message_id || null,
        reply_to: options?.reply_to || null,
        attachments: options?.attachments || [],
        forwarded: options?.forwarded || null,
        mentions: options?.mentions || [],
        link_preview: options?.linkPreview || null,
      }),
    });
    return { response, data: await response.json() };
  });
  if (!response.ok || !data.success) {
    throw createApiError(data, {
      status: response.status,
      statusCode: response.status,
      retryAfterMs: getRetryAfterMsFromResponse(response),
    });
  }
  return normalizeMessage({
    ...data.message,
    content,
    attachments: data.message?.attachments || options?.attachments,
    forwarded: options?.forwarded || undefined,
    mentions: options?.mentions || undefined,
    link_preview: options?.linkPreview || undefined,
  });
}

export async function sendSystemEvent(conversationId: string, content: string): Promise<Message> {
  return sendMessage(conversationId, content, { message_type: 'system' });
}

export async function sendImageOnlyMessage(
  conversationId: string,
  attachments: string[],
  options?: Omit<SendOptions, 'attachments'>,
): Promise<Message> {
  return sendMessage(conversationId, '', { ...options, attachments });
}

export async function sendTypingStart(conversationId: string): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/typing`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const data = await response.json();
  if (!data.success) throw createApiError(data);
}

export async function uploadAttachments(conversationId: string, files: File[]): Promise<string[]> {
  const prepared = await Promise.all(files.map(prepareAttachmentFile));
  const formData = new FormData();
  prepared.forEach(({ file }) => {
    formData.append('files', file, file.name || 'attachment');
  });
  formData.append(
    'metadata',
    JSON.stringify(prepared.map(({ attachment }) => attachment)),
  );

  const { response, data } = await withRequestTimeout(ATTACHMENT_UPLOAD_TIMEOUT_MS, 'Attachment upload', async (signal) => {
    const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/attachments`, {
      method: 'POST',
      signal,
      body: formData,
    });
    return { response, data: await response.json() };
  });
  if (!response.ok || !data.success) {
    throw createApiError(data, {
      status: response.status,
      statusCode: response.status,
      retryAfterMs: getRetryAfterMsFromResponse(response),
    });
  }
  const urls = Array.isArray(data.urls) ? data.urls as string[] : [];
  if (urls.length !== prepared.length) throw new Error('Attachment upload response was incomplete');
  const storedAttachments = Array.isArray(data.attachments) ? data.attachments : [];
  return urls.map((url, index) => {
    const stored = storedAttachments[index];
    const storedMetadata = stored && typeof stored === 'object'
      ? {
          ...(typeof stored.mime === 'string' ? { mime: stored.mime } : {}),
          ...(Number.isFinite(stored.size) ? { size: stored.size } : {}),
          ...(Number.isFinite(stored.width) && stored.width > 0 ? { width: stored.width } : {}),
          ...(Number.isFinite(stored.height) && stored.height > 0 ? { height: stored.height } : {}),
        }
      : {};

    return serializeAttachment({
      ...prepared[index]!.attachment,
      ...storedMetadata,
      url,
    });
  });
}

export async function deleteStagedAttachment(
  conversationId: string,
  rawAttachment: string,
): Promise<void> {
  const attachment = parseAttachment(rawAttachment);
  const stableUrl = attachment.fallback_url?.trim() || attachment.url.trim();
  let attachmentId = attachment.id?.trim() || '';

  if (!attachmentId) {
    try {
      const pathname = new URL(stableUrl, window.location.origin).pathname;
      const match = pathname.match(
        /\/api\/conversations\/[^/]+\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i,
      );
      attachmentId = match?.[1] || '';
    } catch {
      return;
    }
  }
  if (!attachmentId) {
    return;
  }

  const response = await fetchWithAuth(
    `${CHAT_API_PREFIX}/${conversationId}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE' },
  );
  if (response.ok || response.status === 404) {
    return;
  }

  const data = await response.json().catch(() => ({}));
  throw createApiError(data, {
    status: response.status,
    statusCode: response.status,
  });
}

export async function getMessages(
  conversationId: string,
  options?: { before?: string; after?: string; limit?: number },
): Promise<{ messages: Message[]; has_more: boolean }> {
  const params = new URLSearchParams();
  if (options?.before) params.set('before', options.before);
  if (options?.after) params.set('after', options.after);
  if (options?.limit) params.set('limit', String(options.limit));
  const suffix = params.size > 0 ? `?${params}` : '';
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages${suffix}`, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw createApiError(data, {
      status: response.status,
      statusCode: response.status,
      retryAfterMs: getRetryAfterMsFromResponse(response),
    });
  }
  return { messages: (data.messages || []).map(normalizeMessage), has_more: Boolean(data.has_more) };
}

export async function getMessageContext(
  conversationId: string,
  messageId: string,
  options?: { before?: number; after?: number },
): Promise<{ targetMessageId: string; messages: Message[]; hasOlder: boolean; hasNewer: boolean }> {
  const params = new URLSearchParams();
  if (typeof options?.before === 'number') params.set('before', String(options.before));
  if (typeof options?.after === 'number') params.set('after', String(options.after));
  const suffix = params.size > 0 ? `?${params}` : '';
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}/context${suffix}`, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.success) throw createApiError(data, { status: response.status });
  return {
    targetMessageId: String(data.target_message_id || messageId),
    messages: (data.messages || []).map(normalizeMessage),
    hasOlder: Boolean(data.has_older),
    hasNewer: Boolean(data.has_newer),
  };
}

export async function editMessage(
  conversationId: string,
  messageId: string,
  content: string,
  options?: {
    messageType?: string | null;
    attachments?: string[];
    forwarded?: ForwardedMessageMetadata | null;
    mentions?: MessageMentionMetadata[] | null;
    linkPreview?: LinkPreviewMetadata | null;
  },
): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}`, {
    method: 'PUT',
    body: JSON.stringify({
      content,
      message_type: options?.messageType || 'text',
      attachments: options?.attachments || [],
      forwarded: options?.forwarded || null,
      mentions: options?.mentions || [],
      link_preview: options?.linkPreview || null,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw createApiError(data, { status: response.status });
}

export async function updateMessageLinkPreview(
  conversationId: string,
  messageId: string,
  preview: LinkPreviewMetadata,
): Promise<Pick<Message, 'link_preview'>> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}/preview`, {
    method: 'PATCH',
    body: JSON.stringify({ link_preview: preview }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw createApiError(data, { status: response.status });
  return { link_preview: data.link_preview || preview };
}

async function cloneAttachmentsForForward(
  targetConversationId: string,
  sourceAttachments: string[],
  sourceConversationId?: string | null,
): Promise<string[]> {
  const files = await Promise.all(sourceAttachments.map(async (raw, index) => {
    const attachment = parseAttachment(raw);
    const blob = await resolveAttachmentBlob(attachment, { conversationId: sourceConversationId });
    return new File(
      [blob],
      attachment.name?.trim() || `forwarded-attachment-${index + 1}`,
      { type: attachment.mime || blob.type || 'application/octet-stream' },
    );
  }));
  return uploadAttachments(targetConversationId, files);
}

export async function forwardMessageToConversation(
  targetConversation: Conversation,
  sourceMessage: Pick<Message, 'conversation_id' | 'conversation_public_id' | 'message_id' | 'sender_id' | 'content' | 'attachments' | 'created_at' | 'message_type'>,
  options: { currentUserId: string; forwarded: ForwardedMessageMetadata },
): Promise<Message> {
  const content = sourceMessage.content.trim();
  const sourceAttachments = sourceMessage.attachments || [];
  if (!content && sourceAttachments.length === 0) {
    throw new Error('Only messages with text or attachments can be forwarded right now.');
  }
  const sourceConversationId = sourceMessage.conversation_public_id || sourceMessage.conversation_id;
  const attachments = sourceAttachments.length > 0
    ? await cloneAttachmentsForForward(targetConversation.id, sourceAttachments, sourceConversationId)
    : [];
  return sendMessage(targetConversation.id, content, {
    client_message_id: `forward-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    message_type: 'forwarded',
    attachments,
    forwarded: options.forwarded,
  });
}

export async function deleteMessage(conversationId: string, messageId: string): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}`, { method: 'DELETE' });
  const data = await response.json();
  if (!response.ok || !data.success) throw createApiError(data, { status: response.status });
}

export async function markAsRead(conversationId: string, messageId: string): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/read`, {
    method: 'PUT',
    body: JSON.stringify({ message_id: messageId }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw createApiError(data, { status: response.status });
}

export async function toggleReaction(conversationId: string, messageId: string, emoji: string) {
  const response = await fetchWithAuth(
    `${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    { method: 'PUT' },
  );
  const data = await response.json();
  if (!response.ok || !data.success) throw createApiError(data, { status: response.status });
  return data as { action: 'add' | 'remove'; emoji: string; user_id: string };
}

export async function getMessageById(conversationId: string, messageId: string): Promise<Message | null> {
  try {
    const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}`);
    const data = await response.json();
    return response.ok && data.success && data.message ? normalizeMessage(data.message) : null;
  } catch (error) {
    console.error('Failed to fetch single message:', error);
    return null;
  }
}
