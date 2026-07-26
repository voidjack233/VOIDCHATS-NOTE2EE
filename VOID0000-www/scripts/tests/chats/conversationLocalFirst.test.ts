import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  Conversation,
  ConversationDetails,
  Message,
} from '../../../src/Services/Chat/chatTypes';
import {
  areConversationDetailsFresh,
  deleteConversationDetails,
  getConversationDetails,
  requestConversationDetails,
  storeConversationDetails,
  storeConversationSummary,
} from '../../../src/Services/Chat/conversationCache';
import {
  createDmConversationSeed,
  isConversationDetailAuthorizationFailure,
  shouldApplyConversationRefresh,
} from '../../../src/Services/Chat/conversationSelectionPolicy';
import {
  getConversationWindowSnapshot,
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
const { resolveInitialMessageRuntime } = await import(
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

test('existing sidebar selection and new-DM creation remain separate call paths', () => {
  const chatsSource = readFileSync(
    new URL('../../../src/pages/Chat/Chats.tsx', import.meta.url),
    'utf8',
  );
  const managerSource = readFileSync(
    new URL('../../../src/Services/hooks/Chats/useChatManager.ts', import.meta.url),
    'utf8',
  );
  const sidebarSelection = chatsSource.slice(
    chatsSource.indexOf('<ConversationList'),
    chatsSource.indexOf('onCreateGroup=', chatsSource.indexOf('<ConversationList')),
  );
  const existingSelection = managerSource.slice(
    managerSource.indexOf('const handleSelectConversation'),
    managerSource.indexOf('const handleStartDM'),
  );
  const newDmSelection = managerSource.slice(
    managerSource.indexOf('const handleStartDM'),
    managerSource.indexOf('return {', managerSource.indexOf('const handleStartDM')),
  );

  assert.match(sidebarSelection, /handleSelectConversation\(conv\)[\s\S]*navigate\(getDmRoute\(conv\)\)/);
  assert.match(chatsSource, /handleSelectConversation\(createDmConversationSeed\(/);
  assert.match(chatsSource, /useLayoutEffect\(\(\) => \{[\s\S]*const syncRouteState/);
  assert.match(chatsSource, /isPendingDmRoute \|\| !activeConversation/);
  assert.doesNotMatch(existingSelection, /getOrCreateDM/);
  assert.equal(newDmSelection.match(/getOrCreateDM\(/g)?.length, 1);
});
