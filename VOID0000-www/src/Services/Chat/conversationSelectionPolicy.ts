import type { Conversation } from './chatTypes';
import { storeConversationSummary } from './conversationCache';
import { matchesConversationIdentifier } from './utils/conversationUtils';

export const CONVERSATION_DETAIL_FRESHNESS_MS = 60_000;

interface DmConversationSeedPeer {
  id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
}

interface DmStartResult {
  conversation_id: string;
  conversation_public_id?: string | null;
  created: boolean;
}

interface OpenConversationOptions {
  shouldActivate?: () => boolean;
}

type DmStartResolver = (targetId: string) => Promise<DmStartResult>;
type ConversationOpener = (
  identifier: string,
  options?: OpenConversationOptions,
) => Promise<Conversation>;

export const resolveNewDmIdentifiers = async (
  targetId: string,
  resolveDm: DmStartResolver,
) => {
  const {
    conversation_public_id: conversationPublicId,
    conversation_id: conversationId,
    created,
  } = await resolveDm(targetId);

  return {
    conversationId,
    conversationPublicId: conversationPublicId || null,
    routeId: conversationPublicId || conversationId,
    created,
  };
};

export const createDmConversationSeed = ({
  conversationId,
  conversationPublicId,
  peer,
  createdAt = new Date().toISOString(),
}: {
  conversationId: string;
  conversationPublicId?: string | null;
  peer: DmConversationSeedPeer;
  createdAt?: string;
}): Conversation => ({
  id: conversationId,
  public_id: conversationPublicId || null,
  type: 'dm',
  name: null,
  owner_id: null,
  icon_filename: null,
  created_at: createdAt,
  updated_at: createdAt,
  first_message_at: null,
  role: 'member',
  last_read_message_id: null,
  unread_count: 0,
  last_message_id: null,
  last_message_sender_id: null,
  last_message_preview: null,
  dm_user_id: peer.id,
  dm_username: peer.username,
  dm_display_name: peer.display_name || peer.username,
  dm_avatar_url: peer.avatar_url || null,
  member_count: 2,
});

export const prepareDmConversationNavigation = (
  conversation: Conversation,
): Conversation => (
  conversation.type === 'dm'
    ? storeConversationSummary(conversation)
    : conversation
);

export const findBootstrapDmConversation = (
  conversations: Conversation[] | null | undefined,
  routeIdentifier: string | null | undefined,
): Conversation | null => {
  if (!routeIdentifier || !Array.isArray(conversations)) return null;
  return conversations.find((conversation) => (
    conversation.type === 'dm' &&
    matchesConversationIdentifier(conversation, routeIdentifier)
  )) || null;
};

export const shouldSynchronizeDmRoute = ({
  routeIdentifier,
  activeConversation,
  activeGroup,
}: {
  routeIdentifier: string | null | undefined;
  activeConversation: Conversation | null;
  activeGroup: Conversation | null;
}): boolean => Boolean(
  routeIdentifier &&
  (
    activeGroup ||
    activeConversation?.type !== 'dm' ||
    !matchesConversationIdentifier(activeConversation, routeIdentifier)
  )
);

export const synchronizeDmRouteSelection = async ({
  routeIdentifier,
  activeConversation,
  activeGroup,
  openConversation,
  shouldActivate,
}: {
  routeIdentifier: string;
  activeConversation: Conversation | null;
  activeGroup: Conversation | null;
  openConversation: ConversationOpener;
  shouldActivate: () => boolean;
}): Promise<Conversation | null> => {
  if (!shouldSynchronizeDmRoute({
    routeIdentifier,
    activeConversation,
    activeGroup,
  })) {
    return activeConversation;
  }

  return openConversation(routeIdentifier, { shouldActivate });
};

export const isConversationDetailAuthorizationFailure = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const status = Number((error as Record<string, unknown>).status);
  return status === 403 || status === 404;
};

export const shouldApplyConversationRefresh = (
  activeConversation: Conversation | null | undefined,
  refreshedConversation: Conversation,
): boolean => (
  matchesConversationIdentifier(
    activeConversation || null,
    refreshedConversation.public_id || refreshedConversation.id,
  )
);

export type {
  ConversationOpener,
  DmConversationSeedPeer,
  DmStartResolver,
  DmStartResult,
  OpenConversationOptions,
};
