import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../../src/Services/Chat/chatTypes';
import { resolveHistoryLogicalRangeGeometry } from '../../../src/components/Chat/MessageView/messageHistoryRangeGeometry';

Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  value: {
    open: () => ({}),
  },
});

const {
  commitRuntimePaginationBoundary,
  getSavedConversationRuntime,
  resetRuntime,
} = await import('../../../src/Services/hooks/Chats/MessageList/messageListRuntime');
const { resolveInitialMessageRuntime } = await import(
  '../../../src/Services/hooks/Chats/MessageList/messageListInitialRuntime'
);

const makeMessage = (conversationId: string, messageId: string): Message => ({
  conversation_id: conversationId,
  message_id: messageId,
  sender_id: 'user-1',
  content: messageId,
  message_type: 'text',
  reply_to: null,
  is_edited: false,
  edited_at: null,
  is_deleted: false,
  created_at: '2026-08-20T00:00:00.000Z',
});

test('older exhaustion is committed to active and saved runtime state before re-entry', () => {
  const conversationId = 'pagination-older-exhausted';
  const runtime = resetRuntime(
    conversationId,
    [makeMessage(conversationId, 'oldest-message')],
    { hasOlder: true, hasNewer: false, topSpacerHeight: 480 },
  );

  const committed = commitRuntimePaginationBoundary(runtime, 'older', false);
  const savedRuntime = getSavedConversationRuntime(conversationId);
  const restored = resolveInitialMessageRuntime(conversationId, 'none');
  const geometry = resolveHistoryLogicalRangeGeometry({
    topSpacerHeight: restored.runtime.topSpacerHeight,
    bottomSpacerHeight: restored.runtime.bottomSpacerHeight,
    hasOlder: restored.runtime.hasOlder,
    hasNewer: restored.runtime.hasNewer,
    historyLogicalSlotHeight: 360,
  });

  assert.equal(committed.hasOlder, false);
  assert.equal(committed.runtime.hasOlder, false);
  assert.equal(savedRuntime?.hasOlder, false);
  assert.equal(restored.restored, true);
  assert.equal(restored.runtime.hasOlder, false);
  assert.equal(geometry.topLogicalRangeHeight, 0);
  assert.equal(!restored.runtime.hasOlder && geometry.topLogicalRangeHeight <= 1, true);
});

test('an empty terminal older request can commit exhaustion without another page mutation', () => {
  const conversationId = 'pagination-empty-older-page';
  const runtime = resetRuntime(
    conversationId,
    [makeMessage(conversationId, 'only-visible-message')],
    { hasOlder: true, topSpacerHeight: 240 },
  );

  const committed = commitRuntimePaginationBoundary(runtime, 'older', false);
  const savedRuntime = getSavedConversationRuntime(conversationId);

  assert.equal(committed.runtime.renderedIds.length, 1);
  assert.equal(committed.hasOlder, committed.runtime.hasOlder);
  assert.equal(committed.hasOlder, false);
  assert.equal(committed.runtime.topSpacerHeight, 0);
  assert.equal(savedRuntime?.hasOlder, false);
  assert.equal(savedRuntime?.topSpacerHeight, 0);
});

test('newer exhaustion remains symmetric in active and restored runtime state', () => {
  const conversationId = 'pagination-newer-exhausted';
  const runtime = resetRuntime(
    conversationId,
    [makeMessage(conversationId, 'newest-message')],
    { hasOlder: true, hasNewer: true, bottomSpacerHeight: 520 },
  );

  const committed = commitRuntimePaginationBoundary(runtime, 'newer', false);
  const restored = resolveInitialMessageRuntime(conversationId, 'none');
  const geometry = resolveHistoryLogicalRangeGeometry({
    topSpacerHeight: restored.runtime.topSpacerHeight,
    bottomSpacerHeight: restored.runtime.bottomSpacerHeight,
    hasOlder: restored.runtime.hasOlder,
    hasNewer: restored.runtime.hasNewer,
    historyLogicalSlotHeight: 360,
  });

  assert.equal(committed.hasOlder, true);
  assert.equal(committed.hasNewer, false);
  assert.equal(committed.runtime.hasNewer, false);
  assert.equal(restored.runtime.hasNewer, false);
  assert.equal(restored.runtime.bottomSpacerHeight, 0);
  assert.equal(geometry.bottomLogicalRangeHeight, 0);
});

test('an open pagination boundary preserves its existing logical spacer', () => {
  const conversationId = 'pagination-boundary-open';
  const runtime = resetRuntime(
    conversationId,
    [makeMessage(conversationId, 'window-message')],
    { hasOlder: false, hasNewer: false, topSpacerHeight: 180, bottomSpacerHeight: 220 },
  );

  const olderOpen = commitRuntimePaginationBoundary(runtime, 'older', true);
  const newerOpen = commitRuntimePaginationBoundary(olderOpen.runtime, 'newer', true);

  assert.equal(olderOpen.runtime.topSpacerHeight, 180);
  assert.equal(newerOpen.runtime.bottomSpacerHeight, 220);
  assert.equal(newerOpen.hasOlder, newerOpen.runtime.hasOlder);
  assert.equal(newerOpen.hasNewer, newerOpen.runtime.hasNewer);
});
