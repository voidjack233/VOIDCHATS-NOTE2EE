import { MESSAGE_PAGE_SIZE } from './chatConstants';
import type { Message } from './chatTypes';
import type { LocalMessage, SyncCursor } from './chatStore';

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
  initiator?: string;
  savedRuntimeExists?: boolean;
}

type LocalMessageMutationSource = 'incoming_realtime' | 'own_send' | 'unknown';
type SyncRequestReason =
  | 'force_sync'
  | 'missing_validation'
  | 'validation_ttl_expired';
type MessageFetcher = (
  conversationId: string,
  options?: { before?: string; after?: string; limit?: number },
) => Promise<{ messages: Message[]; has_more: boolean }>;
type MessageSyncStore = Pick<
  {
    getMessages(
      conversationId: string,
      options?: { before?: string; after?: string; limit?: number },
    ): Promise<{ messages: LocalMessage[]; has_more: boolean }>;
    getSyncCursor(conversationId: string): Promise<SyncCursor | null>;
    setSyncCursor(
      conversationId: string,
      lastMessageId: string | null,
      lastSyncedAt?: string,
    ): Promise<void>;
    putMessages(messages: LocalMessage[]): Promise<void>;
    putMessage(message: LocalMessage): Promise<void>;
    updateMessage(
      conversationId: string,
      messageId: string,
      updates: Partial<LocalMessage>,
    ): Promise<void>;
    markDeleted(conversationId: string, messageId: string): Promise<void>;
  },
  | 'getMessages'
  | 'getSyncCursor'
  | 'setSyncCursor'
  | 'putMessages'
  | 'putMessage'
  | 'updateMessage'
  | 'markDeleted'
>;
type MessageSyncLogger = (...args: unknown[]) => void;

interface LocalMutationRecord {
  source: LocalMessageMutationSource;
  messageId: string;
  storedAt: number;
}

export const MESSAGE_SYNC_CACHE_TTL_MS = 60 * 1000;

function toLocalMessage(message: Message): LocalMessage {
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

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSyncRequestReason(
  forceSync: boolean,
  lastValidatedAt: number,
): SyncRequestReason {
  if (forceSync) return 'force_sync';
  return lastValidatedAt > 0
    ? 'validation_ttl_expired'
    : 'missing_validation';
}

export class MessageSync {
  private sessionValidatedAtByConversation = new Map<string, number>();
  private syncInFlightByConversation = new Map<string, Promise<SyncResult>>();
  private lastLocalMutationByConversation = new Map<string, LocalMutationRecord>();

  constructor(
    private readonly store: MessageSyncStore,
    private readonly fetchMessages: MessageFetcher,
    private readonly now: () => number = Date.now,
    private readonly log: MessageSyncLogger = () => {},
  ) {}

  async loadConversation(
    conversationId: string,
    options?: LoadConversationOptions,
  ): Promise<{
    cached: { messages: LocalMessage[]; has_more: boolean };
    syncPromise: Promise<SyncResult>;
  }> {
    const initialLimit = options?.initialLimit ?? MESSAGE_PAGE_SIZE;
    const syncLimit = options?.syncLimit ?? MESSAGE_PAGE_SIZE;
    const cached = await this.store.getMessages(conversationId, { limit: initialLimit });
    const cursor = await this.store.getSyncCursor(conversationId);
    const sessionValidatedAt = this.sessionValidatedAtByConversation.get(conversationId) ?? 0;
    const cursorValidatedAt = parseTimestamp(cursor?.last_synced_at);
    const lastValidatedAt = Math.max(sessionValidatedAt, cursorValidatedAt);
    const now = this.now();
    const hasUsableLocalState =
      cached.messages.length > 0 ||
      Boolean(cursor && cursor.last_message_id === null);
    const isFresh = hasUsableLocalState &&
      lastValidatedAt > 0 &&
      now - lastValidatedAt < MESSAGE_SYNC_CACHE_TTL_MS;
    const forceSync = options?.forceSync === true;
    const requestReason = getSyncRequestReason(forceSync, lastValidatedAt);
    const lastLocalMutation = this.lastLocalMutationByConversation.get(conversationId) ?? null;

    this.log('[MESSAGE_SYNC] loadConversation', {
      conversation_id: conversationId,
      saved_runtime_existed: options?.savedRuntimeExists === true,
      local_message_count: cached.messages.length,
      has_usable_local_state: hasUsableLocalState,
      force_sync: forceSync,
      prefer_session_cache: options?.preferSessionCache === true,
      session_validated_at: sessionValidatedAt || null,
      cursor_last_synced_at: cursor?.last_synced_at || null,
      cursor_last_message_id: cursor?.last_message_id || null,
      request_initiator: options?.initiator || 'unknown',
      request_reason: !forceSync && isFresh ? 'fresh_cache' : requestReason,
      last_local_mutation: lastLocalMutation,
    });

    if (!forceSync && isFresh) {
      return {
        cached,
        syncPromise: Promise.resolve({ newMessages: [], hasMore: cached.has_more, didSync: false }),
      };
    }

    let syncPromise = this.syncInFlightByConversation.get(conversationId);
    if (!syncPromise) {
      syncPromise = this.syncFromServer(
        conversationId,
        cached,
        cursor,
        syncLimit,
        requestReason,
        options?.initiator || 'unknown',
      )
        .finally(() => this.syncInFlightByConversation.delete(conversationId));
      this.syncInFlightByConversation.set(conversationId, syncPromise);
    } else {
      this.log('[MESSAGE_SYNC] sharing in-flight reconciliation', {
        conversation_id: conversationId,
        request_initiator: options?.initiator || 'unknown',
      });
    }
    return { cached, syncPromise };
  }

  private async syncFromServer(
    conversationId: string,
    cached: { messages: LocalMessage[]; has_more: boolean },
    cursor: SyncCursor | null,
    limit: number,
    reason: SyncRequestReason,
    initiator: string,
  ): Promise<SyncResult> {
    const validatedCursorId = cursor?.last_message_id || null;
    const requestMode = validatedCursorId ? 'delta' : 'latest';
    this.log('[MESSAGE_SYNC] server reconciliation started', {
      conversation_id: conversationId,
      request_initiator: initiator,
      request_reason: reason,
      request_mode: requestMode,
      after_message_id: validatedCursorId,
      limit,
    });

    try {
      const reconciledById = new Map<string, LocalMessage>();
      let nextValidatedCursorId = validatedCursorId;
      let hasMore = cached.has_more;
      let requestCount = 0;

      if (validatedCursorId) {
        let after = validatedCursorId;
        let hasMoreNewer = false;

        do {
          const result = await this.fetchMessages(conversationId, { after, limit });
          requestCount += 1;
          const localMessages = result.messages.map(toLocalMessage);
          if (localMessages.length > 0) {
            await this.store.putMessages(localMessages);
            localMessages.forEach((message) => {
              reconciledById.set(message.message_id, message);
            });
          }

          const newestPageMessageId = localMessages[0]?.message_id || null;
          hasMoreNewer = result.has_more;
          if (!newestPageMessageId) {
            if (hasMoreNewer) {
              throw new Error('Message delta did not advance its validated cursor');
            }
            break;
          }
          if (newestPageMessageId === after && hasMoreNewer) {
            throw new Error('Message delta repeated its validated cursor');
          }

          after = newestPageMessageId;
          nextValidatedCursorId = newestPageMessageId;
        } while (hasMoreNewer);
      } else {
        const result = await this.fetchMessages(conversationId, { limit });
        requestCount += 1;
        const localMessages = result.messages.map(toLocalMessage);
        if (localMessages.length > 0) {
          await this.store.putMessages(localMessages);
          localMessages.forEach((message) => {
            reconciledById.set(message.message_id, message);
          });
        }
        nextValidatedCursorId =
          localMessages[0]?.message_id ||
          cached.messages[0]?.message_id ||
          null;
        hasMore = result.has_more;
      }

      const validatedAt = this.now();
      await this.store.setSyncCursor(
        conversationId,
        nextValidatedCursorId,
        new Date(validatedAt).toISOString(),
      );
      this.sessionValidatedAtByConversation.set(conversationId, validatedAt);
      const cachedIds = new Set(cached.messages.map((message) => message.message_id));
      const reconciledMessages = [...reconciledById.values()];

      this.log('[MESSAGE_SYNC] server reconciliation completed', {
        conversation_id: conversationId,
        request_mode: requestMode,
        request_count: requestCount,
        reconciled_message_count: reconciledMessages.length,
        validated_cursor_id: nextValidatedCursorId,
        validated_at: validatedAt,
      });

      return {
        newMessages: reconciledMessages.filter((message) => !cachedIds.has(message.message_id)),
        hasMore,
        didSync: true,
      };
    } catch (error) {
      console.error('Background sync failed:', error);
      return { newMessages: [], hasMore: cached.has_more, didSync: false };
    }
  }

  async readLocal(
    conversationId: string,
    options?: { before?: string; after?: string; limit?: number },
  ) {
    return this.store.getMessages(conversationId, options);
  }

  async storeIncomingMessage(
    message: LocalMessage,
    options?: { source?: LocalMessageMutationSource },
  ): Promise<void> {
    await this.store.putMessage(message);
    const mutation = {
      source: options?.source || 'unknown',
      messageId: message.message_id,
      storedAt: this.now(),
    } satisfies LocalMutationRecord;
    this.lastLocalMutationByConversation.set(message.conversation_id, mutation);
    this.log('[MESSAGE_SYNC] stored local message without advancing validation', {
      conversation_id: message.conversation_id,
      message_id: message.message_id,
      source: mutation.source,
    });
  }

  async handleEdit(
    conversationId: string,
    messageId: string,
    updates: Pick<LocalMessage, 'content' | 'edited_at'> & Partial<Pick<LocalMessage, 'forwarded' | 'mentions' | 'link_preview' | 'message_type'>>,
  ): Promise<void> {
    await this.store.updateMessage(conversationId, messageId, {
      ...updates,
      is_edited: true,
    });
  }

  async handlePreviewUpdate(
    conversationId: string,
    messageId: string,
    linkPreview: LocalMessage['link_preview'],
  ): Promise<void> {
    await this.store.updateMessage(conversationId, messageId, { link_preview: linkPreview });
  }

  async handleDelete(conversationId: string, messageId: string): Promise<void> {
    await this.store.markDeleted(conversationId, messageId);
  }

  invalidateConversation(conversationId: string): void {
    this.sessionValidatedAtByConversation.delete(conversationId);
    this.syncInFlightByConversation.delete(conversationId);
    this.lastLocalMutationByConversation.delete(conversationId);
  }
}

export type {
  LoadConversationOptions,
  LocalMessageMutationSource,
  MessageFetcher,
  MessageSyncLogger,
  MessageSyncStore,
  SyncResult,
};
