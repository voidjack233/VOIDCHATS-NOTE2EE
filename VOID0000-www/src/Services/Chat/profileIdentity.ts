import type { Conversation, ConversationMember } from './chatTypes';

export interface ProfileFields {
  display_name?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
  username?: string | null;
}

export interface ProfileUpdate extends ProfileFields {
  user_id: string;
  profile_id: string;
}

export function patchProfileFields<T extends ProfileFields>(record: T, update: ProfileUpdate): T {
  const next = { ...record };
  for (const field of ['display_name', 'avatar_url', 'bio'] as const) {
    // Omission means unchanged; explicit null means cleared, not a stale fallback.
    if (update[field] !== undefined) next[field] = update[field];
  }
  return next;
}

const text = (value?: string | null) => value?.trim() || null;

export function resolveProfileIdentity(
  live?: ProfileFields | null,
  member?: Partial<ConversationMember> | null,
  snapshot?: Pick<Conversation, 'dm_display_name' | 'dm_avatar_url' | 'dm_username' | 'dm_nickname'> | null,
) {
  const username = text(live?.username) || text(member?.username) || text(snapshot?.dm_username);
  const displayName = live?.display_name !== undefined
    ? live.display_name
    : member?.display_name !== undefined ? member.display_name : snapshot?.dm_display_name;
  const avatarUrl = live?.avatar_url !== undefined
    ? live.avatar_url
    : member?.avatar_url !== undefined ? member.avatar_url : snapshot?.dm_avatar_url;
  const nickname = member?.nickname !== undefined ? member.nickname : snapshot?.dm_nickname;
  return {
    displayName: text(nickname) || text(displayName) || username,
    avatarUrl: avatarUrl || null,
    username,
  };
}

export function resolveDmIdentity<T extends ProfileFields & { id: string }>(
  conversation: Conversation,
  members: Record<string, ConversationMember>,
  friends: T[],
  currentUserId?: string,
) {
  const matches = (id: string, username?: string | null) => conversation.dm_user_id
    ? id === conversation.dm_user_id
    : Boolean(conversation.dm_username && username === conversation.dm_username);
  const member = Object.values(members).find((entry) => matches(entry.user_id, entry.username))
    || (!conversation.dm_user_id && !conversation.dm_username && currentUserId
      ? Object.values(members).find((entry) => entry.user_id !== currentUserId) : undefined);
  const friend = friends.find((entry) => member
    ? entry.id === member.user_id : matches(entry.id, entry.username));
  return {
    ...resolveProfileIdentity(friend, member, conversation),
    userId: member?.user_id || friend?.id || conversation.dm_user_id || null,
    friend,
  };
}
