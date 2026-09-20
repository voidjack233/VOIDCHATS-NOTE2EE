import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../../../src/Services/Chat/chatTypes';
import {
  getRenderedMessages,
  patchRenderedMessageIfPresent,
  resetRuntime,
} from '../../../src/Services/hooks/Chats/MessageList/messageListRuntime';
import {
  advanceMessageWindowGeneration,
  clearMessageWindowLoadingIfOwned,
  getMessageWindowResetKey,
  isCurrentMessageWindowGeneration,
  synchronizeMessageWindowRef,
} from '../../../src/Services/hooks/Chats/MessageList/messageListWindowBoundary';
import { mergeMessagesWithReconciliation } from '../../../src/Services/hooks/Chats/MessageList/messageListReconciliation';
import {
  resetHistoryLoadDemand,
  selectPreferredHistoryScrollSignal,
} from '../../../src/components/Chat/MessageView/useMessageTimelineVirtualizer';

Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  value: { open: () => ({}) },
});

const makeMessage = (
  messageId: string,
  sequence: number,
  overrides: Partial<Message> = {},
): Message => ({
  conversation_id: 'timeline-integrity',
  message_id: messageId,
  sender_id: 'user-1',
  content: messageId,
  message_type: 'text',
  reply_to: null,
  is_edited: false,
  edited_at: null,
  is_deleted: false,
  created_at: new Date(Date.UTC(2026, 0, 1, 0, sequence)).toISOString(),
  ...overrides,
});

const latestPage = Array.from({ length: 20 }, (_, index) => (
  makeMessage(`latest-${index + 81}`, index + 81)
));

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
};

test('Jump to Present replaces a historical runtime with only the contiguous latest page', () => {
  const oldHistory = Array.from({ length: 20 }, (_, index) => makeMessage(`old-${index + 1}`, index));
  const historicalRuntime = resetRuntime('timeline-integrity', oldHistory, {
    hasOlder: true,
    hasNewer: true,
    topSpacerHeight: 720,
    bottomSpacerHeight: 720,
  });

  const presentRuntime = resetRuntime('timeline-integrity', latestPage, {
    hasOlder: true,
    hasNewer: false,
  });

  assert.equal(historicalRuntime.renderedIds[0], 'old-1');
  assert.deepEqual(presentRuntime.renderedIds, latestPage.map(message => message.message_id));
  assert.equal(presentRuntime.renderedIds.some(id => id.startsWith('old-')), false);
  assert.equal(presentRuntime.hasNewer, false);
  assert.equal(presentRuntime.bottomSpacerHeight, 0);
});

test('a delayed attachment refresh cannot reinsert a message from the replaced historical window', async () => {
  const oldMessage = makeMessage('old-attachment', 1, {
    attachments: [JSON.stringify({ id: 'image-1', url: 'old-url' })],
  });
  let runtime = resetRuntime('timeline-integrity', [oldMessage], { hasNewer: true });
  assert.deepEqual(runtime.renderedIds, ['old-attachment']);
  let resolveRefresh!: (message: Message) => void;
  const refresh = new Promise<Message>((resolve) => { resolveRefresh = resolve; });

  runtime = resetRuntime('timeline-integrity', latestPage, { hasOlder: true, hasNewer: false });
  resolveRefresh(makeMessage('old-attachment', 1, {
    attachments: [JSON.stringify({ id: 'image-1', url: 'fresh-url' })],
  }));
  const refreshed = await refresh;
  runtime = patchRenderedMessageIfPresent(runtime, refreshed.message_id, current => ({
    ...current,
    attachments: refreshed.attachments,
  }));

  assert.deepEqual(runtime.renderedIds, latestPage.map(message => message.message_id));
  assert.equal(runtime.messageById.has('old-attachment'), false);
  assert.equal(runtime.hasNewer, false);
});

test('the previous insertion-capable reconciliation contract would add an absent refreshed message', () => {
  const oldMessage = makeMessage('old-attachment', 1);
  const result = mergeMessagesWithReconciliation({
    existing: latestPage,
    incoming: [oldMessage],
    trimFrom: 'old',
  });

  assert.equal(result.messages.some(message => message.message_id === oldMessage.message_id), true);
});

test('a pagination response from before Jump to Present is stale and cannot mutate the latest window', async () => {
  const generationRef = { current: 0 };
  const paginationGeneration = generationRef.current;
  let resolveOlder!: (messages: Message[]) => void;
  const olderRequest = new Promise<Message[]>((resolve) => { resolveOlder = resolve; });

  advanceMessageWindowGeneration(generationRef);
  let runtime = resetRuntime('timeline-integrity', latestPage, { hasOlder: true, hasNewer: false });
  resolveOlder([makeMessage('disconnected-old-page', 1)]);
  const olderPage = await olderRequest;
  if (isCurrentMessageWindowGeneration(generationRef, paginationGeneration)) {
    runtime = resetRuntime('timeline-integrity', [...olderPage, ...getRenderedMessages(runtime)]);
  }

  assert.deepEqual(runtime.renderedIds, latestPage.map(message => message.message_id));
});

test('stale loadNewer cleanup cannot release Jump-to-Present loading ownership', async () => {
  const generationRef = { current: 0 };
  const olderPagination = createDeferred<Message[]>();
  const jumpToPresent = createDeferred<Message[]>();
  let loadingNewer = true;
  let appliedPagination = false;
  let appliedPresent = false;
  let newerPaginationStarts = 1;
  const paginationGeneration = generationRef.current;

  const paginationCompletion = olderPagination.promise.then((messages) => {
    if (isCurrentMessageWindowGeneration(generationRef, paginationGeneration)) {
      appliedPagination = messages.length > 0;
    }
  }).finally(() => {
    clearMessageWindowLoadingIfOwned(generationRef, paginationGeneration, () => {
      loadingNewer = false;
    });
  });

  const jumpGeneration = advanceMessageWindowGeneration(generationRef);
  loadingNewer = true;
  const jumpCompletion = jumpToPresent.promise.then((messages) => {
    if (isCurrentMessageWindowGeneration(generationRef, jumpGeneration)) {
      appliedPresent = messages.length === latestPage.length;
    }
  }).finally(() => {
    clearMessageWindowLoadingIfOwned(generationRef, jumpGeneration, () => {
      loadingNewer = false;
    });
  });

  olderPagination.resolve([makeMessage('stale-newer-page', 1)]);
  await paginationCompletion;

  const staleDemandStartedAnotherRequest = (() => {
    if (loadingNewer) return false;
    newerPaginationStarts += 1;
    return true;
  })();
  assert.equal(appliedPagination, false);
  assert.equal(loadingNewer, true);
  assert.equal(staleDemandStartedAnotherRequest, false);
  assert.equal(newerPaginationStarts, 1);

  jumpToPresent.resolve(latestPage);
  await jumpCompletion;
  assert.equal(appliedPresent, true);
  assert.equal(loadingNewer, false);
});

test('stale loadOlder cleanup cannot mutate loading state owned by a newer generation', async () => {
  const generationRef = { current: 4 };
  const loadOlder = createDeferred<void>();
  const olderGeneration = generationRef.current;
  let loadingOlder = true;
  let staleCleanupCalls = 0;
  const completion = loadOlder.promise.finally(() => {
    clearMessageWindowLoadingIfOwned(generationRef, olderGeneration, () => {
      staleCleanupCalls += 1;
      loadingOlder = false;
    });
  });

  const currentGeneration = advanceMessageWindowGeneration(generationRef);
  loadOlder.resolve();
  await completion;

  assert.equal(staleCleanupCalls, 0);
  assert.equal(loadingOlder, true);
  assert.equal(clearMessageWindowLoadingIfOwned(generationRef, currentGeneration, () => {
    loadingOlder = false;
  }), true);
  assert.equal(loadingOlder, false);
});

test('the synchronous message ref sees the present page before a replacement dispatch can render', () => {
  const messagesRef = { current: [makeMessage('historical-cursor', 1)] };
  synchronizeMessageWindowRef(messagesRef, latestPage);

  assert.equal(messagesRef.current[0]?.message_id, 'latest-81');
  assert.equal(messagesRef.current.at(-1)?.message_id, 'latest-100');
});

test('a logical-window reset discards retained history demand and retry state', async () => {
  let retryFired = false;
  const timeout = setTimeout(() => { retryFired = true; }, 10);
  const refs = {
    historyLoadInFlightRef: { current: 'older' as const },
    lastHistoryLoadAtRef: { current: 500 },
    lastScrollTopRef: { current: 100 as number | null },
    lastScrollDirectionSignalRef: { current: { direction: 'older' as const, at: 400 } },
    retainedScrollSignalRef: { current: { direction: 'older' as const, at: 400 } },
    historyLoadRetryDirectionRef: { current: 'older' as const },
    consumedScrollSignalAtRef: { current: { older: 300, newer: 0 } },
    historyLoadRetryTimeoutRef: { current: timeout as ReturnType<typeof setTimeout> | null },
  };

  resetHistoryLoadDemand(refs, 900);
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(retryFired, false);
  assert.equal(refs.retainedScrollSignalRef.current, null);
  assert.equal(refs.lastScrollDirectionSignalRef.current, null);
  assert.equal(refs.historyLoadRetryTimeoutRef.current, null);
  assert.equal(getMessageWindowResetKey('conversation', 2), 'conversation:2');
  assert.notEqual(getMessageWindowResetKey('conversation', 1), getMessageWindowResetKey('conversation', 2));

  const futureSignal = { direction: 'older' as const, at: 800 };
  assert.equal(selectPreferredHistoryScrollSignal({
    preferredDirection: 'older',
    liveSignal: futureSignal,
    retainedSignal: null,
    consumedAt: 0,
    now: 900,
    ttlMs: 1_500,
  }), futureSignal);
});

test('attachment delivery patches a still-visible message without changing window geometry or UI state', () => {
  const visible = makeMessage('visible-attachment', 90, {
    attachments: [JSON.stringify({ id: 'image-1', url: 'old-url' })],
    local_status: 'sending',
    reactions: { 'emoji-1': { emoji: '🔥', count: 1, users: ['user-2'] } },
  });
  const sibling = makeMessage('visible-sibling', 91);
  const original = resetRuntime('timeline-integrity', [visible, sibling], {
    hasOlder: true,
    hasNewer: true,
    topSpacerHeight: 123,
    bottomSpacerHeight: 456,
  });
  const patched = patchRenderedMessageIfPresent(original, visible.message_id, current => ({
    ...current,
    attachments: [JSON.stringify({ id: 'image-1', url: 'fresh-url', expires_at: 12345 })],
  }));
  const patchedMessage = patched.messageById.get(visible.message_id);

  assert.deepEqual(patched.renderedIds, original.renderedIds);
  assert.equal(patched.pages.length, original.pages.length);
  assert.equal(patched.topSpacerHeight, 123);
  assert.equal(patched.bottomSpacerHeight, 456);
  assert.equal(patched.hasOlder, true);
  assert.equal(patched.hasNewer, true);
  assert.equal(patchedMessage?.local_status, 'sending');
  assert.deepEqual(patchedMessage?.reactions, visible.reactions);
  assert.match(patchedMessage?.attachments?.[0] || '', /fresh-url/);
});

test('all delayed completions leave one chronological latest server range', () => {
  let runtime = resetRuntime('timeline-integrity', latestPage, { hasOlder: true, hasNewer: false });
  runtime = patchRenderedMessageIfPresent(runtime, 'old-attachment', current => current);
  const finalMessages = getRenderedMessages(runtime);

  assert.deepEqual(finalMessages.map(message => message.message_id), latestPage.map(message => message.message_id));
  assert.equal(finalMessages.every((message, index) => index === 0 || (
    new Date(finalMessages[index - 1]!.created_at).getTime() <= new Date(message.created_at).getTime()
  )), true);
});
