import type { Conversation } from './chatTypes';
import { matchesConversationIdentifier } from './utils/conversationUtils';

interface DmConversationSeedPeer {
  id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
}

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

export type { DmConversationSeedPeer };
