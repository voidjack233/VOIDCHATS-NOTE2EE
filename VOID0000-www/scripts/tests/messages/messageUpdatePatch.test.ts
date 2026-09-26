import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../../src/Services/Chat/chatService';
import {
  applyMessageUpdate,
  normalizeMessageUpdate,
} from '../../../src/Services/hooks/Chats/MessageList/messageUpdatePatch';

const makeMessage = (overrides: Partial<Message> = {}): Message => ({
  conversation_id: 'conversation-a',
  message_id: 'message-1',
  sender_id: 'user-a',
  content: 'https://example.com',
  message_type: 'text',
  reply_to: null,
  is_edited: false,
  edited_at: null,
  is_deleted: false,
  created_at: '2026-09-27T00:00:00.000Z',
  reactions: {},
  ...overrides,
});

test('preview-only MESSAGE_UPDATE remains a partial patch', () => {
  const preview = { url: 'https://example.com', title: 'Example' };
  const update = normalizeMessageUpdate({
    conversation_id: 'conversation-a',
    message_id: 'message-1',
    link_preview: preview,
  });
  const result = applyMessageUpdate(makeMessage(), update);

  assert.deepEqual(update, { message_id: 'message-1', link_preview: preview });
  assert.equal(result.content, 'https://example.com');
  assert.equal(result.is_edited, false);
  assert.deepEqual(result.link_preview, preview);
});

test('preview-only update preserves an existing edit state', () => {
  const update = normalizeMessageUpdate({
    message_id: 'message-1',
    link_preview: { url: 'https://example.com' },
  });
  const result = applyMessageUpdate(makeMessage({
    content: 'already edited',
    is_edited: true,
    edited_at: '2026-09-27T01:00:00.000Z',
  }), update);

  assert.equal(result.content, 'already edited');
  assert.equal(result.is_edited, true);
  assert.equal(result.edited_at, '2026-09-27T01:00:00.000Z');
});

test('message edits update the fields the server explicitly provides', () => {
  const update = normalizeMessageUpdate({
    message_id: 'message-1',
    content: 'edited content',
    is_edited: true,
    edited_at: '2026-09-27T02:00:00.000Z',
  });
  const result = applyMessageUpdate(makeMessage(), update);

  assert.equal(result.content, 'edited content');
  assert.equal(result.is_edited, true);
  assert.equal(result.edited_at, '2026-09-27T02:00:00.000Z');
});

test('explicit null values remain distinct from omitted fields', () => {
  const omitted = normalizeMessageUpdate({ message_id: 'message-1' });
  const explicitNulls = normalizeMessageUpdate({
    message_id: 'message-1',
    edited_at: null,
    forwarded: null,
    link_preview: null,
  });
  const existing = makeMessage({
    edited_at: '2026-09-27T01:00:00.000Z',
    forwarded: { original_message_id: 'original-1' },
    link_preview: { url: 'https://example.com' },
  });

  assert.equal(Object.hasOwn(omitted, 'edited_at'), false);
  assert.equal(Object.hasOwn(explicitNulls, 'edited_at'), true);
  assert.equal(Object.hasOwn(explicitNulls, 'forwarded'), true);
  assert.equal(Object.hasOwn(explicitNulls, 'link_preview'), true);
  assert.deepEqual(applyMessageUpdate(existing, explicitNulls), {
    ...existing,
    edited_at: null,
    forwarded: null,
    link_preview: null,
  });
});
