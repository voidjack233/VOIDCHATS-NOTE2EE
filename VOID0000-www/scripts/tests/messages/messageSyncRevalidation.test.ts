import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../../src/Services/Chat/chatTypes';
import { MESSAGE_PAGE_SIZE } from '../../../src/Services/Chat/chatConstants';
import type {
  LocalMessage,
  SyncCursor,
} from '../../../src/Services/Chat/chatStore';
import type {
  MessageFetcher,
  MessageSyncStore,
} from '../../../src/Services/Chat/chatSyncCore';
import { messagesNeedAttachmentDeliveryRefresh } from '../../../src/Services/Chat/attachmentDeliveryFreshness';

Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  value: {
    open: () => ({}),
  },
});

const {
  MESSAGE_SYNC_CACHE_TTL_MS,
  MessageSync,
} = await import('../../../src/Services/Chat/chatSyncCore');

const CONVERSATION_ID = 'sync-conversation';
const BASE_TIME = Date.parse('2026-07-27T00:00:00.000Z');

const makeLocalMessage = (
  index: number,
  overrides: Partial<LocalMessage> = {},
): LocalMessage => ({
  conversation_id: CONVERSATION_ID,
  message_id: `message-${index}`,
  sender_id: 'peer-user',
  content: `message ${index}`,
  message_type: 'text',
  reply_to: null,
  is_edited: false,
  edited_at: null,
  is_deleted: false,
  created_at: new Date(BASE_TIME + index * 1_000).toISOString(),
  reactions: {},
  attachments: [],
  ...overrides,
});

const makeServerMessage = (
  index: number,
  overrides: Partial<Message> = {},
): Message => ({
  ...makeLocalMessage(index),
  ...overrides,
});

class FakeMessageStore implements MessageSyncStore {
  private messages = new Map<string, LocalMessage>();
  private cursors = new Map<string, SyncCursor>();

  get storedMessages(): LocalMessage[] {
    return [...this.messages.values()];
  }

  get cursor(): SyncCursor | null {
    return this.cursors.get(CONVERSATION_ID) || null;
  }

  async getMessages(
    conversationId: string,
    options?: { before?: string; after?: string; limit?: number },
  ): Promise<{ messages: LocalMessage[]; has_more: boolean }> {
    const limit = options?.limit || 50;
    const sorted = [...this.messages.values()]
      .filter((message) => message.conversation_id === conversationId)
      .sort((left, right) => (
        right.created_at.localeCompare(left.created_at) ||
        right.message_id.localeCompare(left.message_id)
      ));
    return {
      messages: sorted.slice(0, limit),
      has_more: sorted.length > limit,
    };
  }

  async getSyncCursor(conversationId: string): Promise<SyncCursor | null> {
    return this.cursors.get(conversationId) || null;
  }

  async setSyncCursor(
    conversationId: string,
    lastMessageId: string | null,
    lastSyncedAt?: string,
  ): Promise<void> {
    this.cursors.set(conversationId, {
      conversation_id: conversationId,
      last_message_id: lastMessageId,
      last_synced_at: lastSyncedAt || new Date().toISOString(),
    });
  }

  async putMessages(messages: LocalMessage[]): Promise<void> {
    messages.forEach((message) => {
      this.messages.set(`${message.conversation_id}:${message.message_id}`, message);
    });
  }

  async putMessage(message: LocalMessage): Promise<void> {
    this.messages.set(`${message.conversation_id}:${message.message_id}`, message);
  }

  async updateMessage(
    conversationId: string,
    messageId: string,
    updates: Partial<LocalMessage>,
  ): Promise<void> {
    const key = `${conversationId}:${messageId}`;
    const existing = this.messages.get(key);
    if (existing) {
      this.messages.set(key, { ...existing, ...updates });
    }
  }

  async markDeleted(conversationId: string, messageId: string): Promise<void> {
    await this.updateMessage(conversationId, messageId, {
      is_deleted: true,
      content: '[deleted]',
    });
  }
}

const createFetcher = (
  handler: MessageFetcher,
): {
  fetchMessages: MessageFetcher;
  calls: Array<{
    conversationId: string;
    options?: { before?: string; after?: string; limit?: number };
  }>;
} => {
  const calls: Array<{
    conversationId: string;
    options?: { before?: string; after?: string; limit?: number };
  }> = [];
  return {
    calls,
    fetchMessages: async (conversationId, options) => {
      calls.push({ conversationId, options });
      return handler(conversationId, options);
    },
  };
};

test('fresh cached conversation reopens without a message request', async () => {
  const store = new FakeMessageStore();
  await store.putMessage(makeLocalMessage(1));
  await store.setSyncCursor(
    CONVERSATION_ID,
    'message-1',
    new Date(BASE_TIME).toISOString(),
  );
  const fetcher = createFetcher(async () => {
    throw new Error('Fresh cache must not request messages');
  });
  const sync = new MessageSync(store, fetcher.fetchMessages, () => BASE_TIME);

  const result = await sync.loadConversation(CONVERSATION_ID);
  const reconciliation = await result.syncPromise;

  assert.equal(fetcher.calls.length, 0);
  assert.equal(reconciliation.didSync, false);
  assert.equal(result.cached.messages[0]?.message_id, 'message-1');
});

test('stale cached attachment delivery refreshes the latest window and merges the same message', async () => {
  const now = BASE_TIME;
  const store = new FakeMessageStore();
  const stableUrl =
    '/api/conversations/sync-conversation/attachments/11111111-1111-4111-8111-111111111111';
  await store.putMessage(makeLocalMessage(1, {
    attachments: [JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111',
      fallback_url: stableUrl,
      url: 'https://cdn.invalid/expired',
      url_expires_at: now - 1,
      display_url: 'https://vmd.invalid/expired',
      display_url_expires_at: now - 1,
      inline: true,
      mime: 'image/jpeg',
      width: 640,
      height: 480,
    })],
  }));
  await store.setSyncCursor(
    CONVERSATION_ID,
    'message-1',
    new Date(now).toISOString(),
  );
  const freshDisplayUrl = 'https://vmd.invalid/fresh-small';
  const fetcher = createFetcher(async () => ({
    messages: [makeServerMessage(1, {
      attachments: [JSON.stringify({
        id: '11111111-1111-4111-8111-111111111111',
        fallback_url: stableUrl,
        url: 'https://cdn.invalid/fresh',
        url_expires_at: now + 60_000,
        inline: true,
        mime: 'image/jpeg',
        width: 640,
        height: 480,
        display_variants: {
          small: {
            url: freshDisplayUrl,
            expires_at: now + 60_000,
            width: 480,
          },
        },
      })],
    })],
    has_more: false,
  }));
  const sync = new MessageSync(
    store,
    fetcher.fetchMessages,
    () => now,
    () => {},
    messagesNeedAttachmentDeliveryRefresh,
  );

  const first = await sync.loadConversation(CONVERSATION_ID, { syncLimit: 20 });
  const reconciliation = await first.syncPromise;
  const refreshedAttachment = JSON.parse(
    store.storedMessages[0]?.attachments?.[0] || '{}',
  );
  const second = await sync.loadConversation(CONVERSATION_ID, { syncLimit: 20 });

  assert.deepEqual(fetcher.calls, [{
    conversationId: CONVERSATION_ID,
    options: { limit: 20 },
  }]);
  assert.deepEqual(reconciliation.newMessages, []);
  assert.equal(refreshedAttachment.display_variants.small.url, freshDisplayUrl);
  assert.equal((await second.syncPromise).didSync, false);
});

test('stale validated cursor requests only messages after that cursor', async () => {
  const now = BASE_TIME + MESSAGE_SYNC_CACHE_TTL_MS + 1;
  const store = new FakeMessageStore();
  await store.putMessage(makeLocalMessage(1));
  await store.setSyncCursor(
    CONVERSATION_ID,
    'message-1',
    new Date(BASE_TIME).toISOString(),
  );
  const fetcher = createFetcher(async () => ({
    messages: [makeServerMessage(2)],
    has_more: false,
  }));
  const sync = new MessageSync(store, fetcher.fetchMessages, () => now);

  const result = await sync.loadConversation(CONVERSATION_ID, { syncLimit: 20 });
  const reconciliation = await result.syncPromise;

  assert.deepEqual(fetcher.calls, [{
    conversationId: CONVERSATION_ID,
    options: { after: 'message-1', limit: 20 },
  }]);
  assert.equal(reconciliation.newMessages[0]?.message_id, 'message-2');
  assert.equal(store.cursor?.last_message_id, 'message-2');
});

test('stale delta reconciliation deduplicates a realtime message already stored locally', async () => {
  const now = BASE_TIME + MESSAGE_SYNC_CACHE_TTL_MS + 1;
  const store = new FakeMessageStore();
  await store.putMessage(makeLocalMessage(1));
  await store.setSyncCursor(
    CONVERSATION_ID,
    'message-1',
    new Date(BASE_TIME).toISOString(),
  );
  const fetcher = createFetcher(async () => ({
    messages: [makeServerMessage(2)],
    has_more: false,
  }));
  const sync = new MessageSync(store, fetcher.fetchMessages, () => now);
  await sync.storeIncomingMessage(makeLocalMessage(2), {
    source: 'incoming_realtime',
  });

  const result = await sync.loadConversation(CONVERSATION_ID);
  const reconciliation = await result.syncPromise;

  assert.deepEqual(reconciliation.newMessages, []);
  assert.equal(
    store.storedMessages.filter((message) => message.message_id === 'message-2').length,
    1,
  );
  assert.equal(store.cursor?.last_message_id, 'message-2');
});

test('successful own message persists without invalidating fresh validation', async () => {
  const store = new FakeMessageStore();
  await store.putMessage(makeLocalMessage(1));
  await store.setSyncCursor(
    CONVERSATION_ID,
    'message-1',
    new Date(BASE_TIME).toISOString(),
  );
  const fetcher = createFetcher(async () => {
    throw new Error('Own send must not invalidate a fresh conversation');
  });
  const sync = new MessageSync(store, fetcher.fetchMessages, () => BASE_TIME);

  await sync.storeIncomingMessage(makeLocalMessage(2, { sender_id: 'current-user' }), {
    source: 'own_send',
  });
  const result = await sync.loadConversation(CONVERSATION_ID);
  const reconciliation = await result.syncPromise;

  assert.equal(fetcher.calls.length, 0);
  assert.equal(reconciliation.didSync, false);
  assert.ok(store.storedMessages.some((message) => message.message_id === 'message-2'));
  assert.equal(store.cursor?.last_message_id, 'message-1');
});

test('zero-message delta refreshes validation and suppresses immediate reopening request', async () => {
  const now = BASE_TIME + MESSAGE_SYNC_CACHE_TTL_MS + 1;
  const store = new FakeMessageStore();
  await store.putMessage(makeLocalMessage(1));
  await store.setSyncCursor(
    CONVERSATION_ID,
    'message-1',
    new Date(BASE_TIME).toISOString(),
  );
  const fetcher = createFetcher(async () => ({
    messages: [],
    has_more: false,
  }));
  const sync = new MessageSync(store, fetcher.fetchMessages, () => now);

  const first = await sync.loadConversation(CONVERSATION_ID);
  assert.equal((await first.syncPromise).didSync, true);
  const second = await sync.loadConversation(CONVERSATION_ID);
  assert.equal((await second.syncPromise).didSync, false);

  assert.equal(fetcher.calls.length, 1);
  assert.equal(store.cursor?.last_message_id, 'message-1');
  assert.equal(store.cursor?.last_synced_at, new Date(now).toISOString());
});

test('repeated reopening shares one in-flight reconciliation', async () => {
  const now = BASE_TIME + MESSAGE_SYNC_CACHE_TTL_MS + 1;
  const store = new FakeMessageStore();
  await store.putMessage(makeLocalMessage(1));
  await store.setSyncCursor(
    CONVERSATION_ID,
    'message-1',
    new Date(BASE_TIME).toISOString(),
  );
  let releaseRequest!: (result: { messages: Message[]; has_more: boolean }) => void;
  const fetcher = createFetcher(() => (
    new Promise((resolve) => {
      releaseRequest = resolve;
    })
  ));
  const sync = new MessageSync(store, fetcher.fetchMessages, () => now);

  const [first, second] = await Promise.all([
    sync.loadConversation(CONVERSATION_ID),
    sync.loadConversation(CONVERSATION_ID),
  ]);

  assert.strictEqual(second.syncPromise, first.syncPromise);
  assert.equal(fetcher.calls.length, 1);
  releaseRequest({ messages: [makeServerMessage(2)], has_more: false });
  await Promise.all([first.syncPromise, second.syncPromise]);
});

test('forced gateway or gap reconciliation bypasses freshness but remains incremental', async () => {
  const store = new FakeMessageStore();
  await store.putMessage(makeLocalMessage(1));
  await store.setSyncCursor(
    CONVERSATION_ID,
    'message-1',
    new Date(BASE_TIME).toISOString(),
  );
  const fetcher = createFetcher(async () => ({
    messages: [],
    has_more: false,
  }));
  const sync = new MessageSync(store, fetcher.fetchMessages, () => BASE_TIME);

  const result = await sync.loadConversation(CONVERSATION_ID, {
    forceSync: true,
    initiator: 'gateway_recovery',
  });
  await result.syncPromise;

  assert.deepEqual(fetcher.calls[0]?.options, {
    after: 'message-1',
    limit: MESSAGE_PAGE_SIZE,
  });
});

test('conversation without a validated cursor performs one initial latest-page request', async () => {
  const store = new FakeMessageStore();
  const fetcher = createFetcher(async () => ({
    messages: [makeServerMessage(1)],
    has_more: false,
  }));
  const sync = new MessageSync(store, fetcher.fetchMessages, () => BASE_TIME);

  const result = await sync.loadConversation(CONVERSATION_ID, {
    initialLimit: 20,
    syncLimit: 20,
  });
  await result.syncPromise;

  assert.deepEqual(fetcher.calls, [{
    conversationId: CONVERSATION_ID,
    options: { limit: 20 },
  }]);
  assert.equal(store.cursor?.last_message_id, 'message-1');
});

test('successfully validated empty conversation does not refetch immediately', async () => {
  const store = new FakeMessageStore();
  const fetcher = createFetcher(async () => ({
    messages: [],
    has_more: false,
  }));
  const sync = new MessageSync(store, fetcher.fetchMessages, () => BASE_TIME);

  const first = await sync.loadConversation(CONVERSATION_ID);
  await first.syncPromise;
  const second = await sync.loadConversation(CONVERSATION_ID);
  assert.equal((await second.syncPromise).didSync, false);

  assert.equal(fetcher.calls.length, 1);
  assert.equal(store.cursor?.last_message_id, null);
});

test('multi-page delta reaches the present before advancing the validated cursor', async () => {
  const now = BASE_TIME + MESSAGE_SYNC_CACHE_TTL_MS + 1;
  const store = new FakeMessageStore();
  await store.putMessage(makeLocalMessage(1));
  await store.setSyncCursor(
    CONVERSATION_ID,
    'message-1',
    new Date(BASE_TIME).toISOString(),
  );
  const fetcher = createFetcher(async (_conversationId, options) => {
    if (options?.after === 'message-1') {
      return { messages: [makeServerMessage(2)], has_more: true };
    }
    assert.equal(options?.after, 'message-2');
    return { messages: [makeServerMessage(3)], has_more: false };
  });
  const sync = new MessageSync(store, fetcher.fetchMessages, () => now);

  const result = await sync.loadConversation(CONVERSATION_ID, { syncLimit: 1 });
  await result.syncPromise;

  assert.deepEqual(
    fetcher.calls.map((call) => call.options?.after),
    ['message-1', 'message-2'],
  );
  assert.equal(store.cursor?.last_message_id, 'message-3');
  assert.equal(store.storedMessages.length, 3);
});

test('load diagnostics record cursor, initiator, runtime and preceding mutation source', async () => {
  const now = BASE_TIME + MESSAGE_SYNC_CACHE_TTL_MS + 1;
  const store = new FakeMessageStore();
  await store.putMessage(makeLocalMessage(1));
  await store.setSyncCursor(
    CONVERSATION_ID,
    'message-1',
    new Date(BASE_TIME).toISOString(),
  );
  const fetcher = createFetcher(async () => ({
    messages: [makeServerMessage(2)],
    has_more: false,
  }));
  const logEntries: unknown[][] = [];
  const sync = new MessageSync(
    store,
    fetcher.fetchMessages,
    () => now,
    (...args) => logEntries.push(args),
  );
  await sync.storeIncomingMessage(makeLocalMessage(2, { sender_id: 'current-user' }), {
    source: 'own_send',
  });

  const result = await sync.loadConversation(CONVERSATION_ID, {
    initiator: 'message_list_open',
    savedRuntimeExists: true,
  });
  await result.syncPromise;

  const loadEntry = logEntries.find(([event]) => event === '[MESSAGE_SYNC] loadConversation');
  assert.ok(loadEntry);
  assert.deepEqual(loadEntry[1], {
    conversation_id: CONVERSATION_ID,
    saved_runtime_existed: true,
    local_message_count: 2,
    has_usable_local_state: true,
    attachment_delivery_refresh_required: false,
    force_sync: false,
    prefer_session_cache: false,
    session_validated_at: null,
    cursor_last_synced_at: new Date(BASE_TIME).toISOString(),
    cursor_last_message_id: 'message-1',
    request_initiator: 'message_list_open',
    request_reason: 'validation_ttl_expired',
    last_local_mutation: {
      source: 'own_send',
      messageId: 'message-2',
      storedAt: now,
    },
  });
});
