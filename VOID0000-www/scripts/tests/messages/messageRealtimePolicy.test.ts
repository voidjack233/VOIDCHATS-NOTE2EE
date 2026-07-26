import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../../src/Services/Chat/chatService';
import {
  REALTIME_MESSAGE_QUEUE_RESULT,
  isRealtimeMessageForConversation,
  shouldApplyRealtimeMessageImmediately,
} from '../../../src/Services/hooks/Chats/MessageList/messageRealtimePolicy';
import {
  mergeMessagesWithReconciliation,
} from '../../../src/Services/hooks/Chats/MessageList/messageListReconciliation';

const makeMessage = (overrides: Partial<Message> = {}): Message => ({
  conversation_id: 'conversation-a',
  message_id: 'message-1',
  sender_id: 'user-a',
  content: 'hello',
  message_type: 'text',
  reply_to: null,
  attachments: [],
  is_edited: false,
  edited_at: null,
  is_deleted: false,
  created_at: '2026-07-26T00:00:00.000Z',
  reactions: {},
  ...overrides,
});

test('latest loaded window applies a live message even when viewport is not at bottom', () => {
  assert.equal(shouldApplyRealtimeMessageImmediately({
    hasUnloadedNewerRange: false,
    initialHydrationSettled: true,
  }), true);
});

test('historical window queues server messages but still applies local pending state', () => {
  assert.equal(shouldApplyRealtimeMessageImmediately({
    hasUnloadedNewerRange: true,
    initialHydrationSettled: true,
  }), false);
  assert.equal(shouldApplyRealtimeMessageImmediately({
    hasUnloadedNewerRange: true,
    initialHydrationSettled: true,
    localStatus: 'sending',
  }), true);
  assert.deepEqual(REALTIME_MESSAGE_QUEUE_RESULT, {
    hasNewerAfterFlush: false,
    isAtPresentAfterFlush: true,
  });
});

test('conversation identity filter rejects unrelated realtime events', () => {
  assert.equal(isRealtimeMessageForConversation('conversation-a', 'conversation-a'), true);
  assert.equal(isRealtimeMessageForConversation('conversation-b', 'conversation-a'), false);
});

test('receiver insertion is ordered and reconnect replay remains singular', () => {
  const older = makeMessage({
    message_id: 'message-older',
    created_at: '2026-07-25T23:59:59.000Z',
  });
  const incoming = makeMessage();
  const firstDelivery = mergeMessagesWithReconciliation({
    existing: [older],
    incoming: [incoming],
    trimFrom: 'old',
  });
  const repeatedDelivery = mergeMessagesWithReconciliation({
    existing: firstDelivery.messages,
    incoming: [incoming],
    trimFrom: 'old',
  });

  assert.deepEqual(
    repeatedDelivery.messages.map((message) => message.message_id),
    ['message-older', 'message-1'],
  );
});

test('two clients receive one message in each direction', () => {
  const fromA = makeMessage({
    message_id: 'from-a',
    sender_id: 'user-a',
  });
  const fromB = makeMessage({
    message_id: 'from-b',
    sender_id: 'user-b',
    content: 'reply',
    created_at: '2026-07-26T00:00:01.000Z',
  });

  const apply = (existing: Message[], incoming: Message) => (
    mergeMessagesWithReconciliation({
      existing,
      incoming: [incoming],
      trimFrom: 'old',
    }).messages
  );

  let clientA: Message[] = [];
  let clientB: Message[] = [];
  clientA = apply(clientA, fromA);
  clientB = apply(clientB, fromA);
  clientA = apply(clientA, fromB);
  clientB = apply(clientB, fromB);

  assert.deepEqual(clientA.map((message) => message.message_id), ['from-a', 'from-b']);
  assert.deepEqual(clientB.map((message) => message.message_id), ['from-a', 'from-b']);
});

test('sender echo replaces its optimistic message instead of creating a duplicate', () => {
  const optimistic = makeMessage({
    message_id: 'local-client-1',
    local_client_id: 'client-1',
    client_message_id: 'client-1',
    local_status: 'sending',
  });
  const serverEcho = makeMessage({
    message_id: 'server-message-1',
    local_client_id: 'client-1',
    client_message_id: 'client-1',
    local_status: 'sent',
  });
  const result = mergeMessagesWithReconciliation({
    existing: [optimistic],
    incoming: [serverEcho],
    currentUserId: 'user-a',
    trimFrom: 'old',
    allowOptimisticFallback: true,
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.message_id, 'server-message-1');
});
