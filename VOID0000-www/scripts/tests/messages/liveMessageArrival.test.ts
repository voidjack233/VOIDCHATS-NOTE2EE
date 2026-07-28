import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../../src/Services/Chat/chatService';
import type { MessageStreamEvent } from '../../../src/Services/hooks/Chats/MessageList/messageListTypes';
import { selectLiveMessageArrivals } from '../../../src/components/Chat/MessageView/liveMessageArrival';

const makeMessage = (overrides: Partial<Message> = {}): Message => ({
  conversation_id: 'conversation-a',
  message_id: 'message-1',
  sender_id: 'user-b',
  content: 'hello',
  message_type: 'text',
  reply_to: null,
  attachments: [],
  is_edited: false,
  edited_at: null,
  is_deleted: false,
  created_at: '2026-07-28T00:00:00.000Z',
  reactions: {},
  ...overrides,
});

const makeEvent = (sequence: number, message: Message): MessageStreamEvent => ({
  sequence,
  message,
});

test('selects only a newly arriving live message row', () => {
  const result = selectLiveMessageArrivals({
    events: [makeEvent(1, makeMessage())],
    lastSequence: 0,
    conversationId: 'conversation-a',
    currentUserId: 'user-a',
    visibleMessages: [],
    seenIdentities: new Set(),
  });

  assert.deepEqual(result.arrivalMessageIds, ['message-1']);
  assert.equal(result.hasOwnMessageEvent, false);
  assert.equal(result.lastSequence, 1);
});

test('own send animates only after server confirmation', () => {
  const seenIdentities = new Set<string>();
  const optimistic = makeMessage({
    message_id: 'local-1',
    sender_id: 'user-a',
    local_client_id: 'client-1',
    local_status: 'sending',
  });
  const serverEcho = makeMessage({
    message_id: 'server-1',
    sender_id: 'user-a',
    local_client_id: 'client-1',
    local_status: 'sent',
  });

  const pendingResult = selectLiveMessageArrivals({
    events: [makeEvent(1, optimistic)],
    lastSequence: 0,
    conversationId: 'conversation-a',
    currentUserId: 'user-a',
    visibleMessages: [],
    seenIdentities,
  });
  assert.deepEqual(pendingResult.arrivalMessageIds, []);
  assert.equal(pendingResult.hasOwnMessageEvent, true);
  assert.equal(pendingResult.lastSequence, 1);

  const confirmedResult = selectLiveMessageArrivals({
    events: [makeEvent(1, optimistic), makeEvent(2, serverEcho)],
    lastSequence: pendingResult.lastSequence,
    conversationId: 'conversation-a',
    currentUserId: 'user-a',
    visibleMessages: [optimistic],
    seenIdentities,
  });
  assert.deepEqual(confirmedResult.arrivalMessageIds, ['server-1']);
  assert.equal(confirmedResult.hasOwnMessageEvent, true);
  assert.equal(confirmedResult.lastSequence, 2);

  const replayResult = selectLiveMessageArrivals({
    events: [makeEvent(2, serverEcho), makeEvent(3, serverEcho)],
    lastSequence: confirmedResult.lastSequence,
    conversationId: 'conversation-a',
    currentUserId: 'user-a',
    visibleMessages: [serverEcho],
    seenIdentities,
  });
  assert.deepEqual(replayResult.arrivalMessageIds, []);
});

test('queued and failed own-message states do not animate', () => {
  const queued = makeMessage({
    message_id: 'local-queued',
    sender_id: 'user-a',
    local_client_id: 'client-queued',
    local_status: 'queued',
  });
  const failed = {
    ...queued,
    local_status: 'failed' as const,
  };
  const result = selectLiveMessageArrivals({
    events: [makeEvent(1, queued), makeEvent(2, failed)],
    lastSequence: 0,
    conversationId: 'conversation-a',
    currentUserId: 'user-a',
    visibleMessages: [],
    seenIdentities: new Set(),
  });

  assert.deepEqual(result.arrivalMessageIds, []);
});

test('cached or already rendered messages do not animate', () => {
  const message = makeMessage();
  const result = selectLiveMessageArrivals({
    events: [makeEvent(1, message)],
    lastSequence: 0,
    conversationId: 'conversation-a',
    currentUserId: 'user-a',
    visibleMessages: [message],
    seenIdentities: new Set(),
  });

  assert.deepEqual(result.arrivalMessageIds, []);
});

test('history events and events for another conversation are ignored', () => {
  const seenIdentities = new Set<string>();
  const result = selectLiveMessageArrivals({
    events: [
      makeEvent(1, makeMessage({ message_id: 'old-event' })),
      makeEvent(2, makeMessage({
        conversation_id: 'conversation-b',
        message_id: 'unrelated-event',
      })),
    ],
    lastSequence: 1,
    conversationId: 'conversation-a',
    currentUserId: 'user-a',
    visibleMessages: [],
    seenIdentities,
  });

  assert.deepEqual(result.arrivalMessageIds, []);
  assert.equal(result.lastSequence, 2);
});
