import { useCallback } from 'react';
import { useUser } from '../../Auth/UserContext';
import { ConversationMember } from '../../Chat/chatService';
import { resolveProfileIdentity } from '../../Chat/profileIdentity';
import { useFriends } from '../Friends/useFriends';
import type { ProfileRecord } from '../profile/useProfileRecord';

export const useMessageDisplay = (
  members: Record<string, ConversationMember>,
  userAvatar?: string,
  profile?: ProfileRecord | null,
) => {
  const { user } = useUser();
  const { friends } = useFriends();

  const formatTime = useCallback((dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, []);

  // Profile changes must change these props so memoized message rows update too.
  const getIdentity = useCallback((senderId: string) => {
    const live = senderId === user?.id
      ? { ...user, ...profile, avatar_url: profile ? profile.avatar_url || null : userAvatar }
      : friends.find((friend) => friend.id === senderId);
    return resolveProfileIdentity(live, members[senderId]);
  }, [friends, members, profile, user, userAvatar]);
  const getSenderName = useCallback((senderId: string) => (
    getIdentity(senderId).displayName || (senderId === user?.id ? 'You' : senderId.substring(0, 8))
  ), [getIdentity, user?.id]);
  const getSenderAvatarUrl = useCallback((senderId: string) => getIdentity(senderId).avatarUrl, [getIdentity]);
  const getSenderUsername = useCallback((senderId: string) => getIdentity(senderId).username, [getIdentity]);

  return { formatTime, getSenderName, getSenderAvatarUrl, getSenderUsername };
};
