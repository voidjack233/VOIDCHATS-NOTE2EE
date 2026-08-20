import type { Conversation, Message } from './chatTypes';
import { messageStore, type LocalMessage } from './chatStore';
import { messageSync } from './chatSync';
import {
  createMessagePreviewCandidate,
  createServerPreviewCandidate,
  formatConversationPreview,
  formatServerConversationPreview,
  VersionedConversationPreviewState,
  type ConversationPreviewEntry,
} from './conversationPreviewState';

type LiveMessageCreateEvent = Partial<Message> & Pick<
  Message,
  'conversation_id' | 'message_id' | 'sender_id'
>;
type LiveMessageMutationEvent = Partial<Message> & Pick<
  Message,
  'conversation_id' | 'message_id'
>;

interface StoreHydrationOptions {
  aliases?: Array<string | null | undefined>;
  expectedMutationMessageId?: string;
  mutationRevisionAt?: string;
}

const state = new VersionedConversationPreviewState();
const listeners = new Set<() => void>();

function emitChange() {
  listeners.forEach((listener) => listener());
}

function commitPreview(
  conversationIds: Array<string | null | undefined> | string | null | undefined,
  candidate: Parameters<VersionedConversationPreviewState['commit']>[1],
) {
  if (state.commit(conversationIds, candidate)) emitChange();
}

export function getConversationPreviewEntry(
  conversationId: string | null | undefined,
): ConversationPreviewEntry | null {
  return state.get(conversationId);
}

export function getConversationPreview(conversationId: string | null | undefined): string | null {
  return state.get(conversationId)?.preview ?? null;
}

export function resolveConversationPreview(
  conversation: Conversation,
  currentUserId?: string | null,
): string | null {
  const cached = state.get(conversation.id) || state.get(conversation.public_id);
  return cached && cached.viewerId === (currentUserId || null)
    ? cached.preview
    : formatServerConversationPreview(conversation, currentUserId);
}

export function reconcileConversationPreviewsFromServer(
  conversations: Conversation[],
  currentUserId?: string | null,
): void {
  let changed = false;
  conversations.forEach((conversation) => {
    if (
      typeof conversation.last_message_id === 'undefined' ||
      typeof conversation.last_message_sender_id === 'undefined' ||
      typeof conversation.last_message_preview === 'undefined'
    ) {
      return;
    }
    changed = state.commit(
      [conversation.id, conversation.public_id],
      createServerPreviewCandidate(conversation, currentUserId),
    ) || changed;
  });
  if (changed) emitChange();
}

export function setConversationPreviewFromMessage(
  conversationIds: Array<string | null | undefined> | string | null | undefined,
  message: Message,
  currentUserId?: string | null,
): void {
  commitPreview(
    conversationIds,
    createMessagePreviewCandidate(message, currentUserId, 'view'),
  );
}

export function subscribeConversationPreviewCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function hydrateConversationPreviewFromStore(
  conversationId: string,
  currentUserId?: string | null,
  options: StoreHydrationOptions = {},
): Promise<void> {
  const { messages } = await messageStore.getMessages(conversationId, { limit: 1 });
  const latestMessage = messages[0] || null;
  const ids = [conversationId, ...(options.aliases || [])];

  if (!latestMessage) {
    commitPreview(ids, {
      messageId: null,
      createdAt: null,
      revisionAt: null,
      preview: null,
      source: 'store',
      viewerId: currentUserId || null,
    });
    return;
  }

  const isExpectedMutation = latestMessage.message_id === options.expectedMutationMessageId;
  commitPreview(
    ids,
    createMessagePreviewCandidate(
      latestMessage,
      currentUserId,
      isExpectedMutation ? 'mutation' : 'store',
      isExpectedMutation ? options.mutationRevisionAt : undefined,
    ),
  );
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

function toLocalMessage(message: LiveMessageCreateEvent): LocalMessage {
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
  message: LiveMessageCreateEvent,
  currentUserId?: string | null,
): Promise<string | null> {
  const localMessage = toLocalMessage(message);
  const candidate = createMessagePreviewCandidate(localMessage, currentUserId, 'live');

  // Realtime owns the visible preview immediately; IndexedDB persistence is not
  // allowed to delay it or let an older hydration win afterward.
  commitPreview([message.conversation_id, message.conversation_public_id], candidate);

  await messageSync.storeIncomingMessage(localMessage, {
    source: message.sender_id === currentUserId
      ? 'own_send'
      : 'incoming_realtime',
  });
  return candidate.preview;
}

export async function applyLiveMessageEditPreview(
  message: LiveMessageMutationEvent,
  currentUserId?: string | null,
): Promise<void> {
  const mutationRevisionAt = message.edited_at || new Date().toISOString();
  await messageSync.handleEdit(message.conversation_id, message.message_id, {
    content: message.content ?? '',
    edited_at: mutationRevisionAt,
    message_type: message.message_type || 'text',
    forwarded: message.forwarded,
    mentions: message.mentions,
    link_preview: message.link_preview,
  });
  await hydrateConversationPreviewFromStore(message.conversation_id, currentUserId, {
    aliases: [message.conversation_public_id],
    expectedMutationMessageId: message.message_id,
    mutationRevisionAt,
  });
}

export async function applyLiveMessageDeletePreview(
  message: Pick<
    LiveMessageMutationEvent,
    'conversation_id' | 'conversation_public_id' | 'message_id'
  >,
  currentUserId?: string | null,
): Promise<void> {
  const mutationRevisionAt = new Date().toISOString();
  await messageSync.handleDelete(message.conversation_id, message.message_id);
  await hydrateConversationPreviewFromStore(message.conversation_id, currentUserId, {
    aliases: [message.conversation_public_id],
    expectedMutationMessageId: message.message_id,
    mutationRevisionAt,
  });
}

export { formatConversationPreview };
