import assert from 'node:assert/strict';
import test from 'node:test';
import type { Conversation, Message } from '../../../src/Services/Chat/chatTypes';
import { applyConversationMessageCreate } from '../../../src/Services/Chat/conversationListRealtime';
import {
  createMessagePreviewCandidate,
  createServerPreviewCandidate,
  formatConversationPreview,
  VersionedConversationPreviewState,
  type ConversationPreviewCandidate,
} from '../../../src/Services/Chat/conversationPreviewState';

const CURRENT_USER_ID = 'current-user';
const PEER_USER_ID = 'peer-user';

const makeMessage = (
  messageId: string,
  content: string,
  createdAt: string,
  overrides: Partial<Message> = {},
): Message => ({
  conversation_id: 'conversation-b',
  message_id: messageId,
  sender_id: PEER_USER_ID,
  content,
  message_type: 'text',
  reply_to: null,
  is_edited: false,
  edited_at: null,
  is_deleted: false,
  created_at: createdAt,
  ...overrides,
});

const makeConversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'conversation-b',
  public_id: 'public-b',
  type: 'dm',
  name: null,
  owner_id: null,
  icon_filename: null,
  created_at: '2026-08-20T00:00:00.000Z',
  updated_at: '2026-08-20T00:00:01.000Z',
  role: 'member',
  last_read_message_id: null,
  unread_count: 1,
  last_message_id: 'message-a',
  last_message_sender_id: PEER_USER_ID,
  last_message_preview: 'old',
  dm_username: 'peer',
  dm_display_name: 'Peer',
  dm_avatar_url: null,
  member_count: 2,
  ...overrides,
});

test('incoming inactive-conversation message updates unread metadata, order, and preview immediately', () => {
  const state = new VersionedConversationPreviewState();
  const oldMessage = makeMessage('message-a', 'old', '2026-08-20T00:00:01.000Z');
  const newMessage = makeMessage('message-b', 'new', '2026-08-20T00:00:02.000Z');
  state.commit('conversation-b', createMessagePreviewCandidate(oldMessage, CURRENT_USER_ID, 'store'));
  state.commit('conversation-b', createMessagePreviewCandidate(newMessage, CURRENT_USER_ID, 'live'));

  const conversations = applyConversationMessageCreate({
    conversations: [makeConversation(), makeConversation({ id: 'conversation-c' })],
    conversationId: 'conversation-b',
    messageId: newMessage.message_id,
    senderId: newMessage.sender_id,
    createdAt: newMessage.created_at,
    preview: state.get('conversation-b')?.preview ?? null,
    currentUserId: CURRENT_USER_ID,
    activeConversationId: 'conversation-a',
  });

  assert.equal(state.get('conversation-b')?.preview, 'new');
  assert.equal(conversations[0]?.id, 'conversation-b');
  assert.equal(conversations[0]?.unread_count, 2);
  assert.equal(conversations[0]?.last_message_id, 'message-b');
  assert.equal(conversations[0]?.last_message_preview, 'new');
});

test('stale store hydration cannot overwrite a newer live preview when it resolves later', async () => {
  const state = new VersionedConversationPreviewState();
  const staleCandidate = createMessagePreviewCandidate(
    makeMessage('message-a', 'A', '2026-08-20T00:00:01.000Z'),
    CURRENT_USER_ID,
    'store',
  );
  let resolveHydration!: (candidate: ConversationPreviewCandidate) => void;
  const hydrationCandidate = new Promise<ConversationPreviewCandidate>((resolve) => {
    resolveHydration = resolve;
  });
  const hydration = hydrationCandidate.then((candidate) => {
    state.commit('conversation-b', candidate);
  });

  state.commit('conversation-b', createMessagePreviewCandidate(
    makeMessage('message-b', 'B', '2026-08-20T00:00:02.000Z'),
    CURRENT_USER_ID,
    'live',
  ));
  resolveHydration(staleCandidate);
  await hydration;

  assert.equal(state.get('conversation-b')?.messageId, 'message-b');
  assert.equal(state.get('conversation-b')?.preview, 'B');
});

test('rapid live A to B to C remains C regardless of persistence completion order', () => {
  const state = new VersionedConversationPreviewState();
  const createdAt = '2026-08-20T00:00:02.000Z';
  const messages = [
    makeMessage('message-a', 'A', createdAt),
    makeMessage('message-b', 'B', createdAt),
    makeMessage('message-c', 'C', createdAt),
  ];

  messages.forEach((message) => {
    state.commit('conversation-b', createMessagePreviewCandidate(message, CURRENT_USER_ID, 'live'));
  });
  [messages[1], messages[0], messages[2]].forEach((message) => {
    state.commit('conversation-b', createMessagePreviewCandidate(message, CURRENT_USER_ID, 'store'));
  });

  assert.equal(state.get('conversation-b')?.messageId, 'message-c');
  assert.equal(state.get('conversation-b')?.preview, 'C');
});

test('server last-message identity and preview replace an older local preview', () => {
  const state = new VersionedConversationPreviewState();
  state.commit('conversation-b', createMessagePreviewCandidate(
    makeMessage('message-a', 'A', '2026-08-20T00:00:01.000Z'),
    CURRENT_USER_ID,
    'store',
  ));

  state.commit('conversation-b', createServerPreviewCandidate({
    last_message_id: 'message-b',
    last_message_sender_id: PEER_USER_ID,
    last_message_preview: 'B',
    updated_at: '2026-08-20T00:00:02.000Z',
  }, CURRENT_USER_ID));

  assert.equal(state.get('conversation-b')?.messageId, 'message-b');
  assert.equal(state.get('conversation-b')?.preview, 'B');
});

test('own-message and attachment preview formatting remains unchanged', () => {
  assert.equal(formatConversationPreview(makeMessage(
    'own-text',
    'hello',
    '2026-08-20T00:00:02.000Z',
    { sender_id: CURRENT_USER_ID },
  ), CURRENT_USER_ID), 'You: hello');
  assert.equal(formatConversationPreview(makeMessage(
    'peer-file',
    '',
    '2026-08-20T00:00:03.000Z',
    { attachments: ['attachment'] },
  ), CURRENT_USER_ID), 'Sent an attachment');
  assert.equal(formatConversationPreview(makeMessage(
    'own-file',
    '',
    '2026-08-20T00:00:04.000Z',
    { sender_id: CURRENT_USER_ID, attachments: ['attachment'] },
  ), CURRENT_USER_ID), 'You sent an attachment');

  const serverOwn = createServerPreviewCandidate({
    last_message_id: 'own-server',
    last_message_sender_id: CURRENT_USER_ID,
    last_message_preview: 'server text',
    updated_at: '2026-08-20T00:00:05.000Z',
  }, CURRENT_USER_ID);
  assert.equal(serverOwn.preview, 'You: server text');
});

test('editing or deleting an older message cannot replace the current latest preview', () => {
  const state = new VersionedConversationPreviewState();
  const latest = makeMessage('message-b', 'latest', '2026-08-20T00:00:02.000Z');
  state.commit('conversation-b', createMessagePreviewCandidate(latest, CURRENT_USER_ID, 'live'));

  const olderEdit = makeMessage('message-a', 'older edited', '2026-08-20T00:00:01.000Z', {
    is_edited: true,
    edited_at: '2026-08-20T00:00:03.000Z',
  });
  state.commit('conversation-b', createMessagePreviewCandidate(
    olderEdit,
    CURRENT_USER_ID,
    'mutation',
  ));
  assert.equal(state.get('conversation-b')?.preview, 'latest');

  const latestEdit = { ...latest, content: 'latest edited', is_edited: true };
  state.commit('conversation-b', createMessagePreviewCandidate(
    latestEdit,
    CURRENT_USER_ID,
    'mutation',
    '2026-08-20T00:00:04.000Z',
  ));
  assert.equal(state.get('conversation-b')?.preview, 'latest edited');

  const olderDelete = { ...olderEdit, is_deleted: true };
  state.commit('conversation-b', createMessagePreviewCandidate(
    olderDelete,
    CURRENT_USER_ID,
    'mutation',
    '2026-08-20T00:00:05.000Z',
  ));
  assert.equal(state.get('conversation-b')?.preview, 'latest edited');

  const latestDelete = { ...latestEdit, is_deleted: true };
  state.commit('conversation-b', createMessagePreviewCandidate(
    latestDelete,
    CURRENT_USER_ID,
    'mutation',
    '2026-08-20T00:00:06.000Z',
  ));
  assert.equal(state.get('conversation-b')?.preview, 'Message deleted');
});

test('an older mutation cannot replace a live message created in the same millisecond', () => {
  const state = new VersionedConversationPreviewState();
  const createdAt = '2026-08-20T00:00:02.000Z';
  state.commit('conversation-b', createMessagePreviewCandidate(
    makeMessage('message-b', 'latest', createdAt),
    CURRENT_USER_ID,
    'live',
  ));
  state.commit('conversation-b', createMessagePreviewCandidate(
    makeMessage('message-a', 'older edited', createdAt, { is_edited: true }),
    CURRENT_USER_ID,
    'mutation',
    '2026-08-20T00:00:03.000Z',
  ));

  assert.equal(state.get('conversation-b')?.messageId, 'message-b');
  assert.equal(state.get('conversation-b')?.preview, 'latest');
});

test('the same preview identity is reformatted when the signed-in viewer changes', () => {
  const state = new VersionedConversationPreviewState();
  const message = makeMessage('message-a', 'hello', '2026-08-20T00:00:01.000Z', {
    sender_id: CURRENT_USER_ID,
  });
  state.commit('conversation-b', createMessagePreviewCandidate(
    message,
    CURRENT_USER_ID,
    'store',
  ));
  state.commit('conversation-b', createMessagePreviewCandidate(
    message,
    PEER_USER_ID,
    'store',
  ));

  assert.equal(state.get('conversation-b')?.preview, 'hello');
  assert.equal(state.get('conversation-b')?.viewerId, PEER_USER_ID);
});
