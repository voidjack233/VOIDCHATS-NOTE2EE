import assert from 'node:assert/strict';
import test from 'node:test';
import type { Conversation } from '../../../src/Services/Chat/chatTypes';
import { applyConversationMessageCreate } from '../../../src/Services/Chat/conversationListRealtime';
import {
  formatUnreadBadgeCount,
  getConversationUnreadTotals,
} from '../../../src/Services/Chat/conversationUnreadSummary';

const makeConversation = (
  id: string,
  type: Conversation['type'],
  unreadCount: number,
): Conversation => ({
  id,
  type,
  name: type === 'dm' ? null : id,
  owner_id: null,
  icon_filename: null,
  created_at: '2026-08-21T00:00:00.000Z',
  updated_at: '2026-08-21T00:00:00.000Z',
  role: 'member',
  last_read_message_id: null,
  unread_count: unreadCount,
  dm_username: type === 'dm' ? id : null,
  dm_display_name: type === 'dm' ? id : null,
  dm_avatar_url: null,
  member_count: type === 'dm' ? 2 : 3,
});

test('sums unread messages independently for DMs and groups', () => {
  const totals = getConversationUnreadTotals([
    makeConversation('dm-a', 'dm', 2),
    makeConversation('dm-b', 'dm', 4),
    makeConversation('group-a', 'group', 3),
    makeConversation('channel-a', 'channel', 20),
  ]);

  assert.deepEqual(totals, { dm: 6, group: 3 });
});

test('incoming inactive messages update the corresponding aggregate immediately', () => {
  const conversations = [
    makeConversation('dm-a', 'dm', 1),
    makeConversation('group-a', 'group', 5),
  ];
  const updated = applyConversationMessageCreate({
    conversations,
    conversationId: 'dm-a',
    messageId: 'message-b',
    senderId: 'peer-user',
    createdAt: '2026-08-21T00:00:01.000Z',
    preview: 'new',
    currentUserId: 'current-user',
    activeConversationId: 'group-a',
  });

  assert.deepEqual(getConversationUnreadTotals(updated), { dm: 2, group: 5 });
});

test('reading a conversation removes its messages from the aggregate', () => {
  const conversations = [
    makeConversation('dm-a', 'dm', 7),
    makeConversation('group-a', 'group', 2),
  ];
  const read = conversations.map((conversation) => (
    conversation.id === 'dm-a' ? { ...conversation, unread_count: 0 } : conversation
  ));

  assert.deepEqual(getConversationUnreadTotals(read), { dm: 0, group: 2 });
});

test('invalid counts are ignored and visible badges are capped at 99+', () => {
  const totals = getConversationUnreadTotals([
    makeConversation('dm-negative', 'dm', -2),
    makeConversation('dm-invalid', 'dm', Number.NaN),
    makeConversation('group-large', 'group', 120),
  ]);

  assert.deepEqual(totals, { dm: 0, group: 120 });
  assert.equal(formatUnreadBadgeCount(1), '1');
  assert.equal(formatUnreadBadgeCount(99), '99');
  assert.equal(formatUnreadBadgeCount(100), '99+');
});
