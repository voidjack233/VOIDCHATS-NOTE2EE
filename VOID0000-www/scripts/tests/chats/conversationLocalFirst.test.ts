import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  Conversation,
  ConversationDetails,
  Message,
} from '../../../src/Services/Chat/chatTypes';
import type { LocalMessage } from '../../../src/Services/Chat/chatStore';
import {
  areConversationDetailsFresh,
  deleteConversationDetails,
  getConversationDetails,
  requestConversationDetails,
  requestConversationDetailsIfStale,
  storeConversationDetails,
  storeConversationSummary,
} from '../../../src/Services/Chat/conversationCache';
import {
  CONVERSATION_DETAIL_FRESHNESS_MS,
  createDmConversationSeed,
  findBootstrapDmConversation,
  isConversationDetailAuthorizationFailure,
  prepareDmConversationNavigation,
  resolveNewDmIdentifiers,
  shouldApplyConversationRefresh,
  shouldSynchronizeDmRoute,
  synchronizeDmRouteSelection,
} from '../../../src/Services/Chat/conversationSelectionPolicy';
import {
  getConversationWindowSnapshot,
  hasStableConversationScrollGeometry,
  saveConversationScrollPosition,
  setConversationWindowSnapshot,
} from '../../../src/Services/hooks/Chats/MessageList/messageListWindowCache';
import { shouldShowInitialMessageTimelineSkeleton } from '../../../src/components/Chat/MessageView/messageTimelinePresentation';

Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  value: {
    open: () => ({}),
  },
});

const {
  getRenderedMessages,
  getSavedConversationRuntime,
  resetRuntime,
} = await import('../../../src/Services/hooks/Chats/MessageList/messageListRuntime');
const {
  canSettleInitialHydrationFromCachedWindow,
  createCachedHistoricalWindow,
  hasCachedMessagesAfterWindow,
  resolveInitialMessageRuntime,
} = await import(
  '../../../src/Services/hooks/Chats/MessageList/messageListInitialRuntime'
);

const makeConversation = (
  id: string,
  publicId: string,
  overrides: Partial<Conversation> = {},
): Conversation => ({
  id,
  public_id: publicId,
  type: 'dm',
  name: null,
  owner_id: null,
  icon_filename: null,
  created_at: '2026-07-27T00:00:00.000Z',
  updated_at: '2026-07-27T00:00:00.000Z',
  role: 'member',
  last_read_message_id: null,
  unread_count: 2,
  last_message_id: 'message-latest',
  last_message_sender_id: 'peer-user',
  last_message_preview: 'latest preview',
  dm_user_id: 'peer-user',
  dm_username: 'peer',
  dm_display_name: 'Peer',
  dm_avatar_url: null,
  member_count: 2,
  ...overrides,
});

const makeDetails = (
  conversation: Conversation,
  overrides: Partial<ConversationDetails> = {},
): ConversationDetails => ({
  ...conversation,
  members: [
    {
      user_id: 'current-user',
      role: 'member',
      nickname: null,
      joined_at: '2026-07-27T00:00:00.000Z',
      username: 'current',
      display_name: 'Current',
      avatar_url: null,
      profile_id: 'current-profile',
    },
    {
      user_id: 'peer-user',
      role: 'member',
      nickname: null,
      joined_at: '2026-07-27T00:00:00.000Z',
      username: 'peer',
      display_name: 'Peer',
      avatar_url: null,
      profile_id: 'peer-profile',
    },
  ],
  ...overrides,
});

const makeMessage = (conversationId: string, messageId: string): Message => ({
  conversation_id: conversationId,
  message_id: messageId,
  sender_id: 'peer-user',
  content: messageId,
  message_type: 'text',
  reply_to: null,
  attachments: [],
  is_edited: false,
  edited_at: null,
  is_deleted: false,
  created_at: '2026-07-27T00:00:00.000Z',
  reactions: {},
});

test('known DM summary remains available while its detail request is pending', async () => {
  const summary = makeConversation('local-first-pending', '910000000000000001');
  storeConversationSummary(summary);

  let releaseRequest!: (details: ConversationDetails) => void;
  const pendingRequest = requestConversationDetails(
    summary.public_id!,
    () => new Promise((resolve) => {
      releaseRequest = resolve;
    }),
  );

  assert.equal(getConversationDetails(summary.public_id!)?.dm_display_name, 'Peer');
  assert.equal(getConversationDetails(summary.id)?.last_message_preview, 'latest preview');

  const refreshedDetails = makeDetails(summary);
  delete refreshedDetails.unread_count;
  delete refreshedDetails.last_message_preview;
  releaseRequest(refreshedDetails);
  await pendingRequest;
  assert.equal(getConversationDetails(summary.id)?.unread_count, 2);
  assert.equal(getConversationDetails(summary.id)?.last_message_preview, 'latest preview');
});

test('hard-refresh DM route selects its bootstrap shell by public or internal ID', () => {
  const conversationA = makeConversation('bootstrap-route-a', '910000000000000023');
  const conversationB = makeConversation('bootstrap-route-b', '910000000000000024');
  const group = makeConversation('bootstrap-group', '910000000000000025', {
    type: 'group',
  });
  const conversations = [conversationA, group, conversationB];

  assert.strictEqual(
    findBootstrapDmConversation(conversations, conversationB.public_id),
    conversationB,
  );
  assert.strictEqual(
    findBootstrapDmConversation(conversations, conversationA.id),
    conversationA,
  );
  assert.equal(findBootstrapDmConversation(conversations, group.public_id), null);
  assert.equal(findBootstrapDmConversation(conversations, 'missing'), null);
});

test('saved runtime is selected synchronously and suppresses the full timeline skeleton', () => {
  const conversation = makeConversation('runtime-conversation', '910000000000000002');
  resetRuntime(conversation.id, [makeMessage(conversation.id, 'cached-message')]);

  const initial = resolveInitialMessageRuntime(conversation.id, 'none');
  const messages = getRenderedMessages(initial.runtime);

  assert.equal(initial.restored, true);
  assert.deepEqual(messages.map((message) => message.message_id), ['cached-message']);
  assert.equal(shouldShowInitialMessageTimelineSkeleton({
    loading: !initial.restored,
    initialHydrationSettled: initial.restored,
    visibleMessageCount: messages.length,
  }), false);
});

test('known shell remains local while a conversation with no runtime starts message hydration', () => {
  const summary = makeConversation('uncached-runtime', '910000000000000003');
  storeConversationSummary(summary);

  const initial = resolveInitialMessageRuntime(summary.id, 'none');

  assert.equal(initial.restored, false);
  assert.equal(getConversationDetails(summary.id)?.dm_username, 'peer');
  assert.equal(shouldShowInitialMessageTimelineSkeleton({
    loading: true,
    initialHydrationSettled: false,
    visibleMessageCount: 0,
  }), true);
});

test('cached present messages can render while server reconciliation continues', () => {
  const messages = [makeMessage('cached-present', 'cached-message')];

  assert.equal(canSettleInitialHydrationFromCachedWindow(messages), true);
  assert.equal(canSettleInitialHydrationFromCachedWindow([]), false);
});

test('cached historical window is rebuilt around its anchor without server data', () => {
  const localMessage = (messageId: string, createdAt: string): LocalMessage => ({
    ...makeMessage('cached-history', messageId),
    created_at: createdAt,
    reactions: {},
  });
  const anchor = localMessage('visible-anchor', '2026-07-27T00:00:02.000Z');
  const historicalWindow = createCachedHistoricalWindow({
    anchor,
    before: {
      messages: [localMessage('older-message', '2026-07-27T00:00:01.000Z')],
      has_more: true,
    },
    after: {
      messages: [
        localMessage('newer-message', '2026-07-27T00:00:03.000Z'),
        anchor,
      ],
      has_more: true,
    },
  });

  assert.deepEqual(
    historicalWindow?.messages.map((message) => message.message_id),
    ['older-message', 'visible-anchor', 'newer-message'],
  );
  assert.equal(historicalWindow?.hasOlder, true);
  assert.equal(historicalWindow?.hasNewer, true);
  assert.equal(hasCachedMessagesAfterWindow(
    historicalWindow?.messages || [],
    [localMessage('latest-cached-message', '2026-07-27T00:00:04.000Z')],
  ), true);
  assert.equal(hasCachedMessagesAfterWindow(
    historicalWindow?.messages || [],
    [localMessage('older-cached-message', '2026-07-27T00:00:01.000Z')],
  ), false);
  assert.equal(createCachedHistoricalWindow({
    anchor: null,
    before: { messages: [], has_more: false },
    after: { messages: [], has_more: false },
  }), null);
});

test('detail consumers share one in-flight request across internal and public IDs', async () => {
  const summary = makeConversation('deduped-details', '910000000000000004');
  storeConversationSummary(summary);
  let loadCount = 0;
  let releaseRequest!: (details: ConversationDetails) => void;

  const first = requestConversationDetails(summary.id, () => {
    loadCount += 1;
    return new Promise((resolve) => {
      releaseRequest = resolve;
    });
  }, 'user-a');
  const second = requestConversationDetails(summary.public_id!, async () => {
    loadCount += 1;
    return makeDetails(summary);
  }, 'user-a');

  assert.strictEqual(second, first);
  assert.equal(loadCount, 1);
  releaseRequest(makeDetails(summary));
  await Promise.all([first, second]);
  assert.equal(areConversationDetailsFresh(summary.id, 1_500, 'user-a'), true);
  assert.equal(areConversationDetailsFresh(summary.id, 1_500, 'user-b'), false);

  await requestConversationDetails(summary.id, async () => {
    loadCount += 1;
    return makeDetails(summary);
  }, 'user-b');
  assert.equal(loadCount, 2);
});

test('a failed detail request is removed so a later retry can proceed', async () => {
  const summary = makeConversation('retry-details', '910000000000000005');
  storeConversationSummary(summary);
  let loadCount = 0;

  await assert.rejects(requestConversationDetails(summary.id, async () => {
    loadCount += 1;
    throw new Error('temporary failure');
  }));

  const details = await requestConversationDetails(summary.id, async () => {
    loadCount += 1;
    return makeDetails(summary);
  });

  assert.equal(loadCount, 2);
  assert.equal(details.id, summary.id);
});

test('rapid A to B to A switching rejects a late B detail response', () => {
  const conversationA = makeConversation('rapid-a', '910000000000000006');
  const conversationB = makeConversation('rapid-b', '910000000000000007');

  assert.equal(shouldApplyConversationRefresh(conversationA, conversationB), false);
  assert.equal(shouldApplyConversationRefresh(conversationA, {
    ...conversationA,
    dm_display_name: 'Updated A',
  }), true);
});

test('403 and 404 detail failures are authorization invalidations, unlike transient failures', () => {
  assert.equal(isConversationDetailAuthorizationFailure({ status: 403 }), true);
  assert.equal(isConversationDetailAuthorizationFailure({ status: 404 }), true);
  assert.equal(isConversationDetailAuthorizationFailure({ status: 503 }), false);
  assert.equal(isConversationDetailAuthorizationFailure(new Error('offline')), false);
});

test('conversation invalidation removes both internal and public cache aliases', () => {
  const summary = makeConversation('invalidated-details', '910000000000000008');
  storeConversationDetails(makeDetails(summary));

  deleteConversationDetails(summary.public_id!);

  assert.equal(getConversationDetails(summary.id), null);
  assert.equal(getConversationDetails(summary.public_id!), null);
});

test('detail refresh preserves the existing message runtime and viewport snapshot', () => {
  const summary = makeConversation('stable-runtime', '910000000000000009');
  resetRuntime(summary.id, [makeMessage(summary.id, 'stable-message')], { hasOlder: true });
  setConversationWindowSnapshot(summary.id, {
    loadedCount: 1,
    hasOlder: true,
    topVisibleMessageId: 'stable-message',
    topVisibleMessageOffset: 18,
    scrollTop: 420,
    wasAtBottom: false,
  });

  storeConversationSummary(summary);
  storeConversationDetails(makeDetails(summary, { dm_display_name: 'Fresh Peer' }));

  assert.deepEqual(
    getRenderedMessages(getSavedConversationRuntime(summary.id)!)
      .map((message) => message.message_id),
    ['stable-message'],
  );
  assert.deepEqual(getConversationWindowSnapshot(summary.id), {
    loadedCount: 1,
    hasOlder: true,
    topVisibleMessageId: 'stable-message',
    topVisibleMessageOffset: 18,
    scrollTop: 420,
    wasAtBottom: false,
  });
});

test('each conversation retains an independent saved viewport', () => {
  const conversationA = 'scroll-a';
  const conversationB = 'scroll-b';
  saveConversationScrollPosition(conversationA, {
    messageId: 'a-message',
    offsetTop: -12,
    scrollTop: 800,
    wasAtBottom: false,
  });
  saveConversationScrollPosition(conversationB, {
    messageId: 'b-message',
    offsetTop: 4,
    scrollTop: 120,
    wasAtBottom: true,
  });

  assert.equal(getConversationWindowSnapshot(conversationA)?.topVisibleMessageId, 'a-message');
  assert.equal(getConversationWindowSnapshot(conversationA)?.scrollTop, 800);
  assert.equal(getConversationWindowSnapshot(conversationB)?.topVisibleMessageId, 'b-message');
  assert.equal(getConversationWindowSnapshot(conversationB)?.wasAtBottom, true);
});

test('collapsed mobile scroller geometry is not safe for viewport capture', () => {
  assert.equal(hasStableConversationScrollGeometry({
    clientWidth: 390,
    clientHeight: 695,
    rectWidth: 390,
    rectHeight: 695,
  }), true);
  assert.equal(hasStableConversationScrollGeometry({
    clientWidth: 0,
    clientHeight: 695,
    rectWidth: 0,
    rectHeight: 695,
  }), false);
});

test('a newly resolved DM ID can seed its local shell without another creation request', () => {
  const conversation = createDmConversationSeed({
    conversationId: 'new-dm-internal',
    conversationPublicId: '910000000000000010',
    peer: {
      id: 'new-peer',
      username: 'newpeer',
      display_name: 'New Peer',
      avatar_url: '/avatar.png',
    },
    createdAt: '2026-07-27T01:00:00.000Z',
  });

  assert.equal(conversation.id, 'new-dm-internal');
  assert.equal(conversation.public_id, '910000000000000010');
  assert.equal(conversation.dm_user_id, 'new-peer');
  assert.equal(conversation.dm_display_name, 'New Peer');
});

test('existing DM navigation keeps A active until route B becomes authoritative', async () => {
  const conversationA = makeConversation('route-authority-a', '910000000000000011');
  const conversationB = makeConversation('route-authority-b', '910000000000000012');
  storeConversationSummary(conversationA);

  let activeConversation: Conversation | null = conversationA;
  let routeIdentifier = conversationA.public_id!;
  const activeSequence = [conversationA.id];
  const openedIdentifiers: string[] = [];
  const openConversation = async (identifier: string, options?: { shouldActivate?: () => boolean }) => {
    openedIdentifiers.push(identifier);
    const conversation = getConversationDetails(identifier);
    assert.ok(conversation);
    if (options?.shouldActivate?.() !== false) {
      activeConversation = conversation;
      activeSequence.push(conversation.id);
    }
    return conversation;
  };

  prepareDmConversationNavigation(conversationB);
  assert.equal(activeConversation.id, conversationA.id);
  assert.equal(shouldSynchronizeDmRoute({
    routeIdentifier,
    activeConversation,
    activeGroup: null,
  }), false);

  await synchronizeDmRouteSelection({
    routeIdentifier,
    activeConversation,
    activeGroup: null,
    openConversation,
    shouldActivate: () => true,
  });
  assert.deepEqual(openedIdentifiers, []);

  routeIdentifier = conversationB.public_id!;
  const transition = synchronizeDmRouteSelection({
    routeIdentifier,
    activeConversation,
    activeGroup: null,
    openConversation,
    shouldActivate: () => true,
  });

  assert.equal(activeConversation.id, conversationB.id);
  await transition;
  assert.deepEqual(activeSequence, [conversationA.id, conversationB.id]);
  assert.deepEqual(openedIdentifiers, [conversationB.public_id]);
});

test('fresh cached B details skip background network work', async () => {
  const conversationB = makeConversation('fresh-route-b', '910000000000000013');
  const requestScope = 'fresh-route-user';
  let networkRequests = 0;

  await requestConversationDetails(conversationB.public_id!, async () => {
    networkRequests += 1;
    return makeDetails(conversationB);
  }, requestScope);
  networkRequests = 0;

  const details = await requestConversationDetailsIfStale(
    conversationB.public_id!,
    async () => {
      networkRequests += 1;
      return makeDetails(conversationB);
    },
    {
      maxAgeMs: CONVERSATION_DETAIL_FRESHNESS_MS,
      requestScope,
    },
  );

  assert.equal(details.id, conversationB.id);
  assert.equal(networkRequests, 0);
});

test('stale B detail consumers share one B request and never request A', async () => {
  const conversationA = makeConversation('stale-route-a', '910000000000000014');
  const conversationB = makeConversation('stale-route-b', '910000000000000015');
  const requestScope = 'stale-route-user';
  storeConversationSummary(conversationA);
  storeConversationSummary(conversationB);

  const requestedIdentifiers: string[] = [];
  let releaseRequest!: (details: ConversationDetails) => void;
  const loadB = () => {
    requestedIdentifiers.push(conversationB.public_id!);
    return new Promise<ConversationDetails>((resolve) => {
      releaseRequest = resolve;
    });
  };
  const first = requestConversationDetailsIfStale(
    conversationB.public_id!,
    loadB,
    {
      maxAgeMs: CONVERSATION_DETAIL_FRESHNESS_MS,
      requestScope,
    },
  );
  const second = requestConversationDetailsIfStale(
    conversationB.id,
    loadB,
    {
      maxAgeMs: CONVERSATION_DETAIL_FRESHNESS_MS,
      requestScope,
    },
  );

  assert.strictEqual(second, first);
  assert.deepEqual(requestedIdentifiers, [conversationB.public_id]);
  releaseRequest(makeDetails(conversationB));
  await Promise.all([first, second]);
  assert.equal(requestedIdentifiers.includes(conversationA.public_id!), false);
});

test('rapid A to B to A ignores the cancelled B activation', async () => {
  const conversationA = makeConversation('cancelled-route-a', '910000000000000016');
  const conversationB = makeConversation('cancelled-route-b', '910000000000000017');
  storeConversationSummary(conversationA);
  storeConversationSummary(conversationB);

  let activeConversation: Conversation | null = conversationA;
  let bTransitionCurrent = true;
  let releaseB!: () => void;
  const requestedIdentifiers: string[] = [];
  const activeSequence = [conversationA.id];
  const openConversation = async (identifier: string, options?: { shouldActivate?: () => boolean }) => {
    requestedIdentifiers.push(identifier);
    if (identifier === conversationB.public_id) {
      await new Promise<void>((resolve) => {
        releaseB = resolve;
      });
    }
    const conversation = getConversationDetails(identifier);
    assert.ok(conversation);
    if (options?.shouldActivate?.() !== false) {
      activeConversation = conversation;
      activeSequence.push(conversation.id);
    }
    return conversation;
  };

  const pendingB = synchronizeDmRouteSelection({
    routeIdentifier: conversationB.public_id!,
    activeConversation,
    activeGroup: null,
    openConversation,
    shouldActivate: () => bTransitionCurrent,
  });

  bTransitionCurrent = false;
  await synchronizeDmRouteSelection({
    routeIdentifier: conversationA.public_id!,
    activeConversation,
    activeGroup: null,
    openConversation,
    shouldActivate: () => true,
  });
  releaseB();
  await pendingB;

  assert.equal(activeConversation.id, conversationA.id);
  assert.deepEqual(activeSequence, [conversationA.id]);
  assert.deepEqual(requestedIdentifiers, [conversationB.public_id]);
});

test('direct DM route with missing details resolves exactly once', async () => {
  const conversation = makeConversation('direct-route', '910000000000000018');
  const requestScope = 'direct-route-user';
  let activeConversation: Conversation | null = null;
  let networkRequests = 0;

  await synchronizeDmRouteSelection({
    routeIdentifier: conversation.public_id!,
    activeConversation,
    activeGroup: null,
    openConversation: async (identifier, options) => {
      const details = await requestConversationDetails(identifier, async () => {
        networkRequests += 1;
        return makeDetails(conversation);
      }, requestScope);
      if (options?.shouldActivate?.() !== false) {
        activeConversation = details;
      }
      return details;
    },
    shouldActivate: () => true,
  });

  assert.equal(activeConversation?.id, conversation.id);
  assert.equal(networkRequests, 1);
});

test('browser back and forward select cached routes without fetching the conversation being left', async () => {
  const conversationA = makeConversation('history-route-a', '910000000000000019');
  const conversationB = makeConversation('history-route-b', '910000000000000020');
  storeConversationDetails(makeDetails(conversationA));
  storeConversationDetails(makeDetails(conversationB));

  let activeConversation: Conversation | null = conversationB;
  let networkRequests = 0;
  const openConversation = async (identifier: string, options?: { shouldActivate?: () => boolean }) => {
    const cached = getConversationDetails(identifier);
    if (!cached) {
      networkRequests += 1;
      throw new Error('Unexpected cache miss');
    }
    if (options?.shouldActivate?.() !== false) {
      activeConversation = cached;
    }
    return cached;
  };

  await synchronizeDmRouteSelection({
    routeIdentifier: conversationA.public_id!,
    activeConversation,
    activeGroup: null,
    openConversation,
    shouldActivate: () => true,
  });
  assert.equal(activeConversation.id, conversationA.id);

  await synchronizeDmRouteSelection({
    routeIdentifier: conversationB.public_id!,
    activeConversation,
    activeGroup: null,
    openConversation,
    shouldActivate: () => true,
  });
  assert.equal(activeConversation.id, conversationB.id);
  assert.equal(networkRequests, 0);
});

test('existing DM preparation never resolves a DM while new profile flow resolves once', async () => {
  const existingConversation = makeConversation(
    'existing-no-create',
    '910000000000000021',
  );
  let getOrCreateCalls = 0;

  const prepared = prepareDmConversationNavigation(existingConversation);
  assert.equal(prepared.id, existingConversation.id);
  assert.equal(getOrCreateCalls, 0);

  const resolved = await resolveNewDmIdentifiers('new-peer', async (targetId) => {
    getOrCreateCalls += 1;
    assert.equal(targetId, 'new-peer');
    return {
      conversation_id: 'new-profile-dm',
      conversation_public_id: '910000000000000022',
      created: true,
    };
  });

  assert.equal(getOrCreateCalls, 1);
  assert.equal(resolved.routeId, '910000000000000022');
});
