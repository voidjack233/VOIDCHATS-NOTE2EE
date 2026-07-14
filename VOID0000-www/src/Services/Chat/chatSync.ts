import { MESSAGE_PAGE_SIZE } from './chatConstants';
import { getMessages } from './chatService';
import { messageStore, type LocalMessage } from './chatStore';

interface SyncResult {
  newMessages: LocalMessage[];
  hasMore: boolean;
  didSync: boolean;
}

interface LoadConversationOptions {
  forceSync?: boolean;
  preferSessionCache?: boolean;
  initialLimit?: number;
  syncLimit?: number;
}

const CACHE_TTL_MS = 60 * 1000;

function toLocalMessage(message: Awaited<ReturnType<typeof getMessages>>['messages'][number]): LocalMessage {
  return {
    conversation_id: message.conversation_id,
    message_id: message.message_id,
    sender_id: message.sender_id,
    content: message.content,
    message_type: message.message_type,
    reply_to: message.reply_to,
    is_edited: message.is_edited,
    edited_at: message.edited_at,
    is_deleted: message.is_deleted,
    created_at: message.created_at,
    reactions: message.reactions as Record<string, string[]> || {},
    attachments: message.attachments,
    forwarded: message.forwarded,
    mentions: message.mentions,
    link_preview: message.link_preview,
  };
}

class MessageSync {
  private sessionValidatedAtByConversation = new Map<string, number>();
  private syncInFlightByConversation = new Map<string, Promise<SyncResult>>();

  async loadConversation(
    conversationId: string,
    options?: LoadConversationOptions,
  ): Promise<{
    cached: { messages: LocalMessage[]; has_more: boolean };
    syncPromise: Promise<SyncResult>;
  }> {
    const initialLimit = options?.initialLimit ?? MESSAGE_PAGE_SIZE;
    const syncLimit = options?.syncLimit ?? MESSAGE_PAGE_SIZE;
    const cached = await messageStore.getMessages(conversationId, { limit: initialLimit });
    const cursor = await messageStore.getSyncCursor(conversationId);
    const lastValidated = this.sessionValidatedAtByConversation.get(conversationId) ?? 0;
    const isFresh = Boolean(
      cached.messages.length > 0 &&
      (
        Date.now() - lastValidated < CACHE_TTL_MS ||
        (cursor?.last_synced_at && Date.now() - new Date(cursor.last_synced_at).getTime() < CACHE_TTL_MS)
      )
    );

    if (!options?.forceSync && isFresh) {
      return {
        cached,
        syncPromise: Promise.resolve({ newMessages: [], hasMore: cached.has_more, didSync: false }),
      };
    }

    let syncPromise = this.syncInFlightByConversation.get(conversationId);
    if (!syncPromise) {
      syncPromise = this.syncFromServer(conversationId, cached, syncLimit)
        .finally(() => this.syncInFlightByConversation.delete(conversationId));
      this.syncInFlightByConversation.set(conversationId, syncPromise);
    }
    return { cached, syncPromise };
  }

  private async syncFromServer(
    conversationId: string,
    cached: { messages: LocalMessage[]; has_more: boolean },
    limit: number,
  ): Promise<SyncResult> {
    try {
      const result = await getMessages(conversationId, { limit });
      const localMessages = result.messages.map(toLocalMessage);
      const newestId = localMessages[0]?.message_id || cached.messages[0]?.message_id || '';
      await messageStore.setSyncCursor(conversationId, newestId);
      if (localMessages.length > 0) await messageStore.putMessages(localMessages);
      this.sessionValidatedAtByConversation.set(conversationId, Date.now());
      const cachedIds = new Set(cached.messages.map((message) => message.message_id));
      return {
        newMessages: localMessages.filter((message) => !cachedIds.has(message.message_id)),
        hasMore: result.has_more,
        didSync: true,
      };
    } catch (error) {
      console.error('Background sync failed:', error);
      return { newMessages: [], hasMore: cached.has_more, didSync: true };
    }
  }

  async readLocal(
    conversationId: string,
    options?: { before?: string; after?: string; limit?: number },
  ) {
    return messageStore.getMessages(conversationId, options);
  }

  async storeIncomingMessage(message: LocalMessage): Promise<void> {
    await messageStore.putMessage(message);
  }

  async handleEdit(
    conversationId: string,
    messageId: string,
    updates: Pick<LocalMessage, 'content' | 'edited_at'> & Partial<Pick<LocalMessage, 'forwarded' | 'mentions' | 'link_preview' | 'message_type'>>,
  ): Promise<void> {
    await messageStore.updateMessage(conversationId, messageId, {
      ...updates,
      is_edited: true,
    });
  }

  async handlePreviewUpdate(
    conversationId: string,
    messageId: string,
    linkPreview: LocalMessage['link_preview'],
  ): Promise<void> {
    await messageStore.updateMessage(conversationId, messageId, { link_preview: linkPreview });
  }

  async handleDelete(conversationId: string, messageId: string): Promise<void> {
    await messageStore.markDeleted(conversationId, messageId);
  }

  invalidateConversation(conversationId: string): void {
    this.sessionValidatedAtByConversation.delete(conversationId);
    this.syncInFlightByConversation.delete(conversationId);
  }
}

export const messageSync = new MessageSync();
