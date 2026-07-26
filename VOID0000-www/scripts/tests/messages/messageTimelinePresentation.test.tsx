import assert from 'node:assert/strict';
import test from 'node:test';
import React, { createRef, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../../../src/Services/Chat/chatService';
import { mergeMessagesWithReconciliation } from '../../../src/Services/hooks/Chats/MessageList/messageListReconciliation';
import MessageTimelineViewport from '../../../src/components/Chat/MessageView/MessageTimelineViewport';
import {
  MAX_RENDERED_NEWER_RANGE_HEIGHT,
  shouldShowInitialMessageTimelineSkeleton,
  shouldShowNewerHistoryLoader,
} from '../../../src/components/Chat/MessageView/messageTimelinePresentation';

const renderTimeline = ({
  children,
  loadingOlder = false,
  showNewerLoader = false,
  hasNewer = showNewerLoader,
}: {
  children: ReactNode;
  loadingOlder?: boolean;
  showNewerLoader?: boolean;
  hasNewer?: boolean;
}) => renderToStaticMarkup(
  <MessageTimelineViewport
    setScrollerRef={() => undefined}
    onScroll={() => undefined}
    initialRestoreDone
    topLogicalRangeHeight={loadingOlder ? 120 : 0}
    renderedTopSpacerHeight={loadingOlder ? 120 : 0}
    topHistorySkeletonRowCount={4}
    olderRangeStatus={loadingOlder ? 'loading' : 'loaded'}
    hasOlder={loadingOlder}
    olderSentinelRef={createRef<HTMLDivElement>()}
    showHeader={false}
    header={null}
    bottomLogicalRangeHeight={hasNewer ? 4_000 : 0}
    renderedBottomSpacerHeight={hasNewer ? MAX_RENDERED_NEWER_RANGE_HEIGHT : 0}
    hasNewer={hasNewer}
    showNewerLoader={showNewerLoader}
    newerSentinelRef={createRef<HTMLDivElement>()}
    density="compact"
  >
    {children}
  </MessageTimelineViewport>,
);

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

test('existing messages remain rendered with a localized newer loader', () => {
  const markup = renderTimeline({
    showNewerLoader: true,
    children: <div data-message-id="existing-message">Existing message</div>,
  });

  assert.equal(shouldShowInitialMessageTimelineSkeleton({
    loading: false,
    initialHydrationSettled: true,
    visibleMessageCount: 1,
  }), false);
  assert.equal(shouldShowNewerHistoryLoader({
    loadingNewer: true,
    visibleMessageCount: 1,
  }), true);
  assert.match(markup, /data-message-timeline/);
  assert.match(markup, /data-message-id="existing-message"/);
  assert.match(markup, /data-message-newer-loader/);
  assert.doesNotMatch(markup, /Loading older messages/);
});

test('older pagination preserves existing timeline rows', () => {
  const markup = renderTimeline({
    loadingOlder: true,
    children: <div data-message-id="existing-message">Existing message</div>,
  });

  assert.equal(shouldShowInitialMessageTimelineSkeleton({
    loading: false,
    initialHydrationSettled: true,
    visibleMessageCount: 1,
  }), false);
  assert.match(markup, /data-message-timeline/);
  assert.match(markup, /data-message-id="existing-message"/);
});

test('genuine initial loading without messages shows the initial skeleton policy', () => {
  assert.equal(shouldShowInitialMessageTimelineSkeleton({
    loading: true,
    initialHydrationSettled: false,
    visibleMessageCount: 0,
  }), true);
});

test('cached messages remain visible during background synchronization', () => {
  assert.equal(shouldShowInitialMessageTimelineSkeleton({
    loading: true,
    initialHydrationSettled: true,
    visibleMessageCount: 2,
  }), false);

  const markup = renderTimeline({
    children: <div data-message-id="cached-message">Cached message</div>,
  });
  assert.match(markup, /data-message-id="cached-message"/);
});

test('incoming realtime reconciliation stays singular while newer pagination is active', () => {
  const existing = makeMessage({
    message_id: 'existing-message',
    created_at: '2026-07-25T23:59:59.000Z',
  });
  const incoming = makeMessage({ message_id: 'incoming-message' });
  const firstMerge = mergeMessagesWithReconciliation({
    existing: [existing],
    incoming: [incoming],
    trimFrom: 'old',
  });
  const replayMerge = mergeMessagesWithReconciliation({
    existing: firstMerge.messages,
    incoming: [incoming],
    trimFrom: 'old',
  });
  const markup = renderTimeline({
    showNewerLoader: true,
    children: replayMerge.messages.map((message) => (
      <div key={message.message_id} data-message-id={message.message_id}>
        {message.content}
      </div>
    )),
  });

  assert.match(markup, /data-message-id="existing-message"/);
  assert.equal(markup.match(/data-message-id="incoming-message"/g)?.length, 1);
  assert.match(markup, /data-message-newer-loader/);
});

test('conversation change without cached messages retains initial skeleton behavior', () => {
  assert.equal(shouldShowInitialMessageTimelineSkeleton({
    loading: true,
    initialHydrationSettled: false,
    visibleMessageCount: 0,
  }), true);
});

test('loading completion keeps the timeline structure and removes only the localized loader', () => {
  const children = <div data-message-id="stable-message">Stable message</div>;
  const loadingMarkup = renderTimeline({
    showNewerLoader: true,
    children,
  });
  const loadedMarkup = renderTimeline({
    showNewerLoader: false,
    hasNewer: false,
    children,
  });

  assert.match(loadingMarkup, /data-message-timeline/);
  assert.match(loadedMarkup, /data-message-timeline/);
  assert.match(loadingMarkup, /data-message-id="stable-message"/);
  assert.match(loadedMarkup, /data-message-id="stable-message"/);
  assert.match(loadingMarkup, /height:72px/);
  assert.doesNotMatch(loadedMarkup, /data-message-newer-loader/);
});
