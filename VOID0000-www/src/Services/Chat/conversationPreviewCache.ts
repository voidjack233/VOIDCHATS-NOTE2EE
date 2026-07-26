import type { Message } from './chatTypes';
import { messageStore, type LocalMessage } from './chatStore';
import { messageSync } from './chatSync';

type PreviewSource = Pick<
  Message | LocalMessage,
  'sender_id' | 'content' | 'attachments' | 'is_deleted' | 'message_type'
>;

type LiveMessageEvent = Partial<Message> & Pick<Message, 'conversation_id' | 'message_id' | 'sender_id'>;

const cache = new Map<string, string | null>();
const listeners = new Set<() => void>();
const MAX_PREVIEW_LENGTH = 120;

const normalizeText = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
};

function emitChange() {
  listeners.forEach((listener) => listener());
}

function truncatePreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= MAX_PREVIEW_LENGTH
    ? compact
    : `${compact.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}...`;
}

export function formatConversationPreview(
  message: PreviewSource | null | undefined,
  currentUserId?: string | null,
): string | null {
  if (!message) return null;
  if (message.is_deleted) return 'Message deleted';

  const attachmentCount = message.attachments?.length || 0;
  const isSender = Boolean(currentUserId && message.sender_id === currentUserId);
  if (attachmentCount > 0) {
    if (isSender) return attachmentCount > 1 ? `You sent ${attachmentCount} attachments` : 'You sent an attachment';
    return attachmentCount > 1 ? `Sent ${attachmentCount} attachments` : 'Sent an attachment';
  }

  const content = normalizeText(message.content);
  if (!content) return null;
  const preview = truncatePreview(content);
  return isSender && message.message_type !== 'system' ? `You: ${preview}` : preview;
}

export function getConversationPreview(conversationId: string | null | undefined): string | null {
  return conversationId ? cache.get(conversationId) ?? null : null;
}

export function setConversationPreview(
  conversationIds: Array<string | null | undefined> | string | null | undefined,
  preview: string | null,
): void {
  const ids = Array.isArray(conversationIds) ? conversationIds : [conversationIds];
  let changed = false;
  ids.forEach((id) => {
    if (!id || (cache.get(id) ?? null) === preview) return;
    cache.set(id, preview);
    changed = true;
  });
  if (changed) emitChange();
}

export function subscribeConversationPreviewCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function hydrateConversationPreviewFromStore(
  conversationId: string,
  currentUserId?: string | null,
): Promise<void> {
  const { messages } = await messageStore.getMessages(conversationId, { limit: 1 });
  setConversationPreview(conversationId, formatConversationPreview(messages[0] || null, currentUserId));
}

export async function hydrateConversationPreviewsFromStore(
  conversationIds: string[],
  currentUserId?: string | null,
): Promise<void> {
  await Promise.all([...new Set(conversationIds.filter(Boolean))].map((conversationId) =>
    hydrateConversationPreviewFromStore(conversationId, currentUserId).catch((error) => {
      console.warn('[CONVERSATION_PREVIEW] failed to hydrate preview from store', {
        conversation_id: conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  ));
}

function toLocalMessage(message: LiveMessageEvent): LocalMessage {
  return {
    conversation_id: message.conversation_id,
    message_id: message.message_id,
    sender_id: message.sender_id,
    content: message.is_deleted ? '[deleted]' : message.content ?? '',
    message_type: message.message_type || 'text',
    reply_to: message.reply_to ?? null,
    is_edited: Boolean(message.is_edited),
    edited_at: message.edited_at ?? null,
    is_deleted: Boolean(message.is_deleted),
    created_at: message.created_at || new Date().toISOString(),
    reactions: {},
    attachments: message.attachments,
    forwarded: message.forwarded,
    mentions: message.mentions,
    link_preview: message.link_preview,
  };
}

export async function applyLiveMessagePreview(
  message: LiveMessageEvent,
  currentUserId?: string | null,
): Promise<string | null> {
  const localMessage = toLocalMessage(message);
  await messageSync.storeIncomingMessage(localMessage, {
    source: message.sender_id === currentUserId
      ? 'own_send'
      : 'incoming_realtime',
  });
  const preview = formatConversationPreview(localMessage, currentUserId);
  setConversationPreview([message.conversation_id, message.conversation_public_id], preview);
  return preview;
}

export async function applyLiveMessageEditPreview(
  message: LiveMessageEvent,
  currentUserId?: string | null,
): Promise<void> {
  await messageSync.handleEdit(message.conversation_id, message.message_id, {
    content: message.content ?? '',
    edited_at: message.edited_at || new Date().toISOString(),
    message_type: message.message_type || 'text',
    forwarded: message.forwarded,
    mentions: message.mentions,
    link_preview: message.link_preview,
  });
  await hydrateConversationPreviewFromStore(message.conversation_id, currentUserId);
  if (message.conversation_public_id) {
    setConversationPreview(message.conversation_public_id, getConversationPreview(message.conversation_id));
  }
}

export async function applyLiveMessageDeletePreview(
  message: Pick<LiveMessageEvent, 'conversation_id' | 'conversation_public_id' | 'message_id'>,
  currentUserId?: string | null,
): Promise<void> {
  await messageSync.handleDelete(message.conversation_id, message.message_id);
  await hydrateConversationPreviewFromStore(message.conversation_id, currentUserId);
  if (message.conversation_public_id) {
    setConversationPreview(message.conversation_public_id, getConversationPreview(message.conversation_id));
  }
}
