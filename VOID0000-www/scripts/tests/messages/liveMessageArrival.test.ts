import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('reaction, edit, preview, and attachment updates do not reanimate an existing identity', () => {
  const seenIdentities = new Set<string>();
  const initialMessage = makeMessage();
  const first = selectLiveMessageArrivals({
    events: [makeEvent(1, initialMessage)],
    lastSequence: 0,
    conversationId: 'conversation-a',
    currentUserId: 'user-a',
    visibleMessages: [],
    seenIdentities,
  });
  assert.deepEqual(first.arrivalMessageIds, ['message-1']);

  const updatedMessage = makeMessage({
    content: 'edited',
    is_edited: true,
    reactions: { wave: ['user-a'] },
    attachments: ['updated-attachment'],
    link_preview: { url: 'https://example.com' },
  });
  const updated = selectLiveMessageArrivals({
    events: [makeEvent(2, updatedMessage)],
    lastSequence: first.lastSequence,
    conversationId: 'conversation-a',
    currentUserId: 'user-a',
    visibleMessages: [updatedMessage],
    seenIdentities,
  });

  assert.deepEqual(updated.arrivalMessageIds, []);
});

test('message entrance uses one subtle transform and opacity animation', async () => {
  const css = await readFile(
    new URL('../../../src/index.css', import.meta.url),
    'utf8',
  );
  const start = css.indexOf('@keyframes message-live-arrival');
  const end = css.indexOf('@media (prefers-reduced-motion: reduce)', start);
  assert.ok(start >= 0 && end > start);
  const animationCss = css.slice(start, end);

  assert.match(animationCss, /opacity:\s*0[\s\S]+opacity:\s*1/);
  assert.match(animationCss, /translate3d\(var\(--message-live-arrival-start-x\), 0, 0\)/);
  assert.match(animationCss, /translate3d\(0, 0, 0\)/);
  assert.match(animationCss, /180ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/);
  assert.match(animationCss, /message-live-arrival-from-left[\s\S]+-10px/);
  assert.match(animationCss, /message-live-arrival-from-right[\s\S]+10px/);
  assert.doesNotMatch(
    animationCss,
    /overshoot|70%|scale|rotate|translateY|height|width|margin|padding/,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]+\.message-live-arrival\s*\{[\s\S]+animation:\s*none/,
  );

  const messageItem = await readFile(
    new URL(
      '../../../src/components/Chat/Messages/MessageItem.tsx',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    messageItem,
    /const isRightAligned = isOwn && density === 'comfortable'/,
  );
  assert.match(
    messageItem,
    /isRightAligned \? 'message-live-arrival-from-right' : 'message-live-arrival-from-left'/,
  );
  assert.match(
    messageItem,
    /className=\{`flex min-w-0 max-w-full flex-col[\s\S]+liveArrivalClassName/,
  );
});
