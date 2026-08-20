import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import React, { createRef, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../../../src/Services/Chat/chatService';
import { mergeMessagesWithReconciliation } from '../../../src/Services/hooks/Chats/MessageList/messageListReconciliation';
import MessageTimelineViewport from '../../../src/components/Chat/MessageView/MessageTimelineViewport';
import { HISTORY_SKELETON_ROW_HEIGHT } from '../../../src/components/Chat/MessageView/historySkeletonConstants';
import {
  getHistoryLogicalSlotHeight,
  getRenderedNewerHistoryRangeLimit,
  shouldShowInitialMessageTimelineSkeleton,
} from '../../../src/components/Chat/MessageView/messageTimelinePresentation';
import { getTopSpacerScrollCompensation } from '../../../src/components/Chat/MessageView/useMessageScrollGeometry';

Object.defineProperty(globalThis, 'React', {
  configurable: true,
  value: React,
});

const renderTimeline = ({
  children,
  loadingOlder = false,
  loadingNewer = false,
  hasNewer = loadingNewer,
  density = 'compact',
}: {
  children: ReactNode;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  hasNewer?: boolean;
  density?: 'compact' | 'comfortable';
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
    renderedBottomSpacerHeight={hasNewer || loadingNewer
      ? getRenderedNewerHistoryRangeLimit({
          historyLogicalSlotHeight: 4_000,
          prefetchDistance: density === 'compact' ? 720 : 640,
        })
      : 0}
    bottomHistorySkeletonRowCount={Math.max(
      4,
      Math.ceil(
        (density === 'compact' ? 720 : 640) / HISTORY_SKELETON_ROW_HEIGHT[density],
      ) + 1,
    )}
    newerRangeStatus={loadingNewer ? 'loading' : 'loaded'}
    hasNewer={hasNewer}
    loadingNewer={loadingNewer}
    newerSentinelRef={createRef<HTMLDivElement>()}
    density={density}
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

test('older and newer pagination use the same history skeleton at opposite edges', () => {
  const markup = renderTimeline({
    loadingOlder: true,
    loadingNewer: true,
    children: <div data-message-id="existing-message">Existing message</div>,
  });

  assert.equal(shouldShowInitialMessageTimelineSkeleton({
    loading: false,
    initialHydrationSettled: true,
    visibleMessageCount: 1,
  }), false);
  assert.match(markup, /data-message-timeline/);
  assert.match(markup, /data-message-id="existing-message"/);
  assert.match(markup, /data-message-older-skeleton/);
  assert.match(markup, /data-message-newer-skeleton/);
  assert.equal(markup.match(/data-history-skeleton=/g)?.length, 2);
  assert.match(markup, /data-history-skeleton-anchor="end"/);
  assert.match(markup, /data-history-skeleton-anchor="start"/);

  const olderIndex = markup.indexOf('data-message-older-skeleton');
  const messageIndex = markup.indexOf('data-message-id="existing-message"');
  const newerIndex = markup.indexOf('data-message-newer-skeleton');
  assert.ok(olderIndex < messageIndex);
  assert.ok(messageIndex < newerIndex);
  assert.doesNotMatch(markup, /Loading newer messages\.\.\./);
  assert.doesNotMatch(markup, /animate-spin/);
  assert.doesNotMatch(markup, /<svg/);
  assert.doesNotMatch(markup, /data-message-newer-loader/);
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
  assert.match(markup, /data-message-older-skeleton/);
  assert.match(markup, /data-history-skeleton-anchor="end"/);
});

test('unloaded newer range shows full history rows before its fetch starts', () => {
  const markup = renderTimeline({
    loadingNewer: false,
    hasNewer: true,
    children: <div data-message-id="existing-message">Existing message</div>,
  });

  assert.match(markup, /data-message-newer-skeleton/);
  assert.match(markup, /data-history-skeleton-anchor="start"/);
  assert.match(markup, /height:75px/);
  assert.match(markup, /height:720px/);
  assert.equal(markup.match(/data-history-skeleton-row/g)?.length, 11);
});

test('newer history uses one bounded prefetch window instead of a fixed row count', () => {
  assert.equal(getRenderedNewerHistoryRangeLimit({
    historyLogicalSlotHeight: 4_000,
    prefetchDistance: 720,
  }), 720);
  assert.equal(getRenderedNewerHistoryRangeLimit({
    historyLogicalSlotHeight: 500,
    prefetchDistance: 720,
  }), 500);

  const comfortableMarkup = renderTimeline({
    hasNewer: true,
    density: 'comfortable',
    children: <div data-message-id="existing-message">Existing message</div>,
  });
  assert.match(comfortableMarkup, /height:640px/);
  assert.match(comfortableMarkup, /height:98px/);
});

test('logical history geometry is stable for each density and independent of message contents', () => {
  assert.equal(getHistoryLogicalSlotHeight({
    pageSize: 20,
    skeletonRowHeight: HISTORY_SKELETON_ROW_HEIGHT.compact,
  }), 1_500);
  assert.equal(getHistoryLogicalSlotHeight({
    pageSize: 20,
    skeletonRowHeight: HISTORY_SKELETON_ROW_HEIGHT.comfortable,
  }), 1_960);
});

test('ordinary top spacer changes preserve rendered row position below the compaction cap', () => {
  assert.equal(getTopSpacerScrollCompensation({
    previousHeight: 1_500,
    nextHeight: 1_780,
    blocked: false,
  }), 280);
  assert.equal(getTopSpacerScrollCompensation({
    previousHeight: 1_500,
    nextHeight: 1_780,
    blocked: true,
  }), 0);
});

test('media loading cannot directly issue timeline scroll corrections', async () => {
  const messageViewSource = await readFile(
    new URL('../../../src/components/Chat/MessageView/MessageViewV2.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(messageViewSource, /onAttachmentLoad=/);
  assert.doesNotMatch(messageViewSource, /handleAttachmentLoad/);
});

test('message-row color transitions are scoped to jump highlighting', async () => {
  const messageItemSource = await readFile(
    new URL('../../../src/components/Chat/Messages/MessageItem.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(messageItemSource, /overflow-x-clip px-2 transition-colors duration-300/);
  assert.doesNotMatch(messageItemSource, /className=\{`px-2 transition-colors duration-300/);
  assert.match(
    messageItemSource,
    /isHighlighted \? '[^']*transition-colors duration-300' : ''/,
  );
});

test('desktop action rail disarms on scroll and only re-arms from mouse movement', async () => {
  const messageItemSource = await readFile(
    new URL('../../../src/components/Chat/Messages/MessageItem.tsx', import.meta.url),
    'utf8',
  );

  assert.match(messageItemSource, /onMouseMove=\{handleDesktopActionRailMouseMove\}/);
  assert.match(
    messageItemSource,
    /window\.addEventListener\('scroll', hideDesktopActionRail, true\)/,
  );
  assert.doesNotMatch(
    messageItemSource,
    /window\.addEventListener\('scroll', updateDesktopActionRailPosition, true\)/,
  );
  assert.match(
    messageItemSource,
    /window\.addEventListener\('resize', updateDesktopActionRailPosition\)/,
  );
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
    loadingNewer: true,
    children: replayMerge.messages.map((message) => (
      <div key={message.message_id} data-message-id={message.message_id}>
        {message.content}
      </div>
    )),
  });

  assert.match(markup, /data-message-id="existing-message"/);
  assert.equal(markup.match(/data-message-id="incoming-message"/g)?.length, 1);
  assert.match(markup, /data-message-newer-skeleton/);
});

test('conversation change without cached messages retains initial skeleton behavior', () => {
  assert.equal(shouldShowInitialMessageTimelineSkeleton({
    loading: true,
    initialHydrationSettled: false,
    visibleMessageCount: 0,
  }), true);
});

test('loading completion replaces only the bottom range with reconciled newer rows', () => {
  const children = <div data-message-id="stable-message">Stable message</div>;
  const loadingMarkup = renderTimeline({
    loadingNewer: true,
    children,
  });
  const loadedMarkup = renderTimeline({
    loadingNewer: false,
    hasNewer: false,
    children: (
      <>
        {children}
        <div data-message-id="newer-message">Newer message</div>
      </>
    ),
  });

  assert.match(loadingMarkup, /data-message-timeline/);
  assert.match(loadedMarkup, /data-message-timeline/);
  assert.match(loadingMarkup, /data-message-id="stable-message"/);
  assert.match(loadedMarkup, /data-message-id="stable-message"/);
  assert.equal(loadedMarkup.match(/data-message-id="stable-message"/g)?.length, 1);
  assert.equal(loadedMarkup.match(/data-message-id="newer-message"/g)?.length, 1);
  assert.match(loadingMarkup, /height:720px/);
  assert.match(loadingMarkup, /data-message-newer-skeleton/);
  assert.doesNotMatch(loadedMarkup, /data-message-newer-skeleton/);
});
